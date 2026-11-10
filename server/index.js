import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COOKIE, hashPassword, newId, readCookie, sessionCookie, verifyPassword } from "./auth.js";
import { listConnectors, runConnector } from "./connectors.js";
import { audit, openDatabase, saveSentiment } from "./db.js";
import { projectRules, textMatches } from "./match.js";
import { analyze } from "./sentiment.js";
import { buildXlsx, cadenceKey, htmlToPdf } from "./reports.js";

const ROLE_PERMS = {
  viewer: new Set(["read"]),
  analyst: new Set(["read", "write", "ingest", "export"]),
  admin: new Set(["read", "write", "ingest", "export", "members", "audit"]),
  owner: new Set(["read", "write", "ingest", "export", "members", "audit", "manage"]),
};

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY = 7 * 24 * 3600;

function can(member, perm) {
  return Boolean(member && ROLE_PERMS[member.role]?.has(perm));
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": Buffer.isBuffer(body) ? (headers["content-type"] || "application/octet-stream") : "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function windowOf(search) {
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 30);
  const fromDay = search.get("from") || start.toISOString().slice(0, 10);
  const toDay = search.get("to") || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
    return { error: "Dates must be YYYY-MM-DD." };
  }
  return { from: `${fromDay}T00:00:00.000Z`, to: `${toDay}T23:59:59.999Z`, fromDay, toDay };
}

function previousWindow(from, to) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  const prevTo = new Date(start - 1);
  const prevFrom = new Date(prevTo.getTime() - (end - start));
  return { from: prevFrom.toISOString(), to: prevTo.toISOString() };
}

function publicPost(row) {
  return {
    id: row.id,
    platform: row.platform_code,
    author: row.author_name,
    handle: row.author_handle,
    postedAt: row.posted_at,
    url: row.url,
    text: row.text,
    language: row.language,
    likes: row.likes,
    comments: row.comments_count,
    shares: row.shares,
    engagement: row.likes + row.comments_count + row.shares,
    sentiment: row.sentiment_label,
    score: row.sentiment_score,
    crisisRisk: row.crisis_risk,
    sample: row.sample === 1,
    source: row.source,
    live: row.sample !== 1 && row.source === "official",
  };
}

function loadAuth(db, req) {
  const sid = readCookie(req, COOKIE);
  if (!sid) return null;
  const session = db.prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?").get(sid, new Date().toISOString());
  if (!session) return null;
  const user = db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(session.user_id);
  const membership = db.prepare("SELECT * FROM memberships WHERE user_id = ? AND organization_id = ?").get(user.id, session.organization_id);
  const organization = db.prepare("SELECT id, name FROM organizations WHERE id = ?").get(session.organization_id);
  const memberships = db.prepare(`SELECT m.organization_id AS id, m.role, o.name
    FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? ORDER BY o.name`).all(user.id);
  return { session, user, membership, organization, memberships };
}

function mePayload(auth) {
  return {
    user: {
      id: auth.user.id,
      email: auth.user.email,
      name: auth.user.name,
      role: auth.membership.role,
      organization: auth.organization,
      memberships: auth.memberships,
    },
    liveConnectors: false,
    sampleData: true,
  };
}

function postsIn(db, orgId, from, to) {
  return db.prepare("SELECT * FROM posts WHERE organization_id = ? AND posted_at >= ? AND posted_at <= ?").all(orgId, from, to);
}

function loadRules(db, orgId, projectId) {
  const project = db.prepare("SELECT * FROM projects WHERE id = ? AND organization_id = ?").get(projectId, orgId);
  if (!project) return null;
  const keywords = db.prepare("SELECT * FROM keywords WHERE project_id = ? AND organization_id = ?").all(projectId, orgId);
  const conditions = db.prepare("SELECT * FROM boolean_conditions WHERE project_id = ? AND organization_id = ? ORDER BY position").all(projectId, orgId);
  return {
    project,
    rules: projectRules(
      keywords.filter((row) => row.kind === "include"),
      keywords.filter((row) => row.kind === "exclude"),
      conditions,
    ),
    keywords,
    conditions,
  };
}

function compareCompetitors(db, orgId, from, to) {
  const posts = postsIn(db, orgId, from, to);
  const projects = db.prepare("SELECT id FROM projects WHERE organization_id = ?").all(orgId);
  const ownPosts = posts.filter((post) => projects.some((project) => {
    const loaded = loadRules(db, orgId, project.id);
    return loaded && textMatches(post.text, loaded.rules);
  }));
  const competitors = db.prepare("SELECT * FROM competitors WHERE organization_id = ? ORDER BY name").all(orgId);
  const buckets = competitors.map((competitor) => {
    const terms = db.prepare("SELECT term FROM competitor_terms WHERE competitor_id = ? AND organization_id = ?").all(competitor.id, orgId).map((row) => row.term);
    const matched = posts.filter((post) => terms.some((term) => post.text.toLowerCase().includes(term.toLowerCase())));
    const engagement = matched.reduce((sum, post) => sum + post.likes + post.comments_count + post.shares, 0);
    const sentiment = matched.length ? matched.reduce((sum, post) => sum + post.sentiment_score, 0) / matched.length : 0;
    return { id: competitor.id, name: competitor.name, terms, mentions: matched.length, engagement, sentiment: Number(sentiment.toFixed(4)) };
  });
  const ownEngagement = ownPosts.reduce((sum, post) => sum + post.likes + post.comments_count + post.shares, 0);
  const ownSentiment = ownPosts.length ? ownPosts.reduce((sum, post) => sum + post.sentiment_score, 0) / ownPosts.length : 0;
  const denom = ownPosts.length + buckets.reduce((sum, bucket) => sum + bucket.mentions, 0);
  return {
    own: {
      name: "Өөрийн төслүүд",
      mentions: ownPosts.length,
      engagement: ownEngagement,
      sentiment: Number(ownSentiment.toFixed(4)),
      share: denom ? ownPosts.length / denom : 0,
    },
    competitors: buckets.map((bucket) => ({ ...bucket, share: denom ? bucket.mentions / denom : 0 })),
    sample: true,
    live: false,
  };
}

function topicMetrics(db, orgId, topicId, from, to) {
  const posts = db.prepare(`SELECT p.* FROM posts p
    JOIN topic_posts tp ON tp.post_id = p.id
    WHERE tp.topic_id = ? AND p.organization_id = ? AND p.posted_at >= ? AND p.posted_at <= ?`).all(topicId, orgId, from, to);
  const platforms = {};
  let engagement = 0;
  let sentiment = 0;
  for (const post of posts) {
    platforms[post.platform_code] = (platforms[post.platform_code] || 0) + 1;
    engagement += post.likes + post.comments_count + post.shares;
    sentiment += post.sentiment_score;
  }
  return {
    mentions: posts.length,
    engagement,
    sentiment: posts.length ? Number((sentiment / posts.length).toFixed(4)) : 0,
    platforms,
  };
}

function deny(db, res, auth, perm) {
  audit(db, {
    organizationId: auth?.organization?.id || null,
    userId: auth?.user?.id || null,
    action: "deny",
    entity: "permission",
    detail: perm,
  });
  send(res, 403, { error: "Permission denied." });
}

function requireUser(db, res, auth, perm) {
  if (!auth) {
    send(res, 401, { error: "Sign in required." });
    return false;
  }
  if (perm && !can(auth.membership, perm)) {
    deny(db, res, auth, perm);
    return false;
  }
  return true;
}

async function handleApi(req, res, db, url) {
  const path = url.pathname;
  const method = req.method;
  const auth = loadAuth(db, req);
  const body = method === "GET" || method === "HEAD" ? {} : await readBody(req);

  if (method === "POST" && path === "/api/auth/register") {
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const organizationName = String(body.organizationName || "").trim();
    if (name.length < 1 || organizationName.length < 1 || !email.includes("@") || password.length < 8) {
      return send(res, 400, { error: "Name, organization, a valid email, and a password of at least 8 characters are required." });
    }
    if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
      return send(res, 409, { error: "That email is already registered." });
    }
    const now = new Date().toISOString();
    const userId = newId();
    const orgId = newId();
    const sessionId = newId();
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(userId, email, name, hashPassword(password), now);
      db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)").run(orgId, organizationName, now);
      db.prepare("INSERT INTO memberships (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)").run(newId(), orgId, userId, now);
      db.prepare("INSERT INTO sessions (id, user_id, organization_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
        sessionId, userId, orgId, now, new Date(Date.now() + DAY * 1000).toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    audit(db, { organizationId: orgId, userId, action: "register", entity: "organization", entityId: orgId });
    return send(res, 201, { ok: true }, { "set-cookie": sessionCookie(sessionId, DAY) });
  }

  if (method === "POST" && path === "/api/auth/login") {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      audit(db, { action: "login_failed", entity: "user", detail: email.slice(0, 120) });
      return send(res, 401, { error: "Email or password is wrong." });
    }
    const membership = db.prepare("SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1").get(user.id);
    if (!membership) return send(res, 403, { error: "This user has no organization." });
    const sessionId = newId();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO sessions (id, user_id, organization_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
      sessionId, user.id, membership.organization_id, now, new Date(Date.now() + DAY * 1000).toISOString(),
    );
    audit(db, { organizationId: membership.organization_id, userId: user.id, action: "login", entity: "session" });
    return send(res, 200, { ok: true }, { "set-cookie": sessionCookie(sessionId, DAY) });
  }

  if (method === "POST" && path === "/api/auth/logout") {
    if (auth) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(auth.session.id);
      audit(db, { organizationId: auth.organization.id, userId: auth.user.id, action: "logout", entity: "session" });
    }
    return send(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
  }

  if (method === "GET" && path === "/api/auth/me") {
    if (!auth) return send(res, 200, { user: null, liveConnectors: false, sampleData: true });
    return send(res, 200, mePayload(auth));
  }

  if (method === "POST" && path === "/api/auth/switch") {
    if (!requireUser(db, res, auth)) return;
    const membership = db.prepare("SELECT * FROM memberships WHERE user_id = ? AND organization_id = ?").get(auth.user.id, String(body.organizationId || ""));
    if (!membership) return send(res, 404, { error: "Organization not found." });
    db.prepare("UPDATE sessions SET organization_id = ? WHERE id = ?").run(membership.organization_id, auth.session.id);
    audit(db, { organizationId: membership.organization_id, userId: auth.user.id, action: "switch", entity: "organization", entityId: membership.organization_id });
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && path === "/api/auth/password") {
    if (!requireUser(db, res, auth)) return;
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(auth.user.id);
    if (!verifyPassword(String(body.current || ""), user.password_hash)) return send(res, 400, { error: "Current password is wrong." });
    if (String(body.next || "").length < 8) return send(res, 400, { error: "New password must be at least 8 characters." });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(String(body.next)), user.id);
    audit(db, { organizationId: auth.organization.id, userId: user.id, action: "password", entity: "user", entityId: user.id });
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && path === "/api/auth/forgot") {
    const email = String(body.email || "").trim().toLowerCase();
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    const message = "Email delivery is not configured. If the account exists, a local reset token is included.";
    if (!user) return send(res, 200, { delivered: false, message });
    const token = randomBytes(24).toString("hex");
    const now = new Date();
    db.prepare("INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)").run(
      newId(), user.id, tokenHash(token), new Date(now.getTime() + 3600 * 1000).toISOString(),
    );
    audit(db, { userId: user.id, action: "forgot", entity: "user", entityId: user.id, detail: "token issued locally" });
    return send(res, 200, { delivered: false, demoResetToken: token, message });
  }

  if (method === "POST" && path === "/api/auth/reset") {
    const token = String(body.token || "");
    const password = String(body.password || "");
    if (password.length < 8) return send(res, 400, { error: "Password must be at least 8 characters." });
    const row = db.prepare("SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").get(tokenHash(token), new Date().toISOString());
    if (!row) return send(res, 400, { error: "Reset token is invalid or expired." });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), row.user_id);
    db.prepare("UPDATE password_resets SET used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    audit(db, { userId: row.user_id, action: "reset", entity: "user", entityId: row.user_id });
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && path === "/api/contact") {
    return send(res, 200, { ok: true, delivered: false, message: "Email delivery is not configured. The message was not stored." });
  }

  if (method === "GET" && path === "/api/help") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const catalog = [
      { test: /монитор|monitoring|feed/, mn: "Хяналт нь постоо нэг жагсаалтад харуулна. Мөр бүр дээр жишээ гэж тэмдэглэгдэнэ.", en: "Monitoring is one feed. Sample rows are labeled sample data." },
      { test: /түлхүүр|keyword/, mn: "Төсөл дээр оруулах, хасах, ALL / ANY / NOT нөхцөл хадгална.", en: "Projects store include, exclude, and ALL / ANY / NOT terms." },
      { test: /платформ|platform|facebook|youtube/, mn: "Facebook, X, Instagram, Threads, YouTube, вэб. Албан холболт тохируулаагүй.", en: "Facebook, X, Instagram, Threads, YouTube, and the web. Official connectors are not configured." },
    ];
    const hit = catalog.find((item) => item.test.test(q));
    return send(res, 200, {
      live: false,
      reply: hit ? `${hit.mn} / ${hit.en}` : "Энэ бол локал тайлбар. Гадаад загвар дуудаагүй. / Local guide only. No external model was called.",
    });
  }

  if (!auth) return send(res, 401, { error: "Sign in required." });
  const orgId = auth.organization.id;

  if (method === "GET" && path === "/api/dashboard") {
    if (!requireUser(db, res, auth, "read")) return;
    const span = windowOf(url.searchParams);
    if (span.error) return send(res, 400, { error: span.error });
    const posts = postsIn(db, orgId, span.from, span.to);
    const comments = db.prepare("SELECT * FROM comments WHERE organization_id = ? AND posted_at >= ? AND posted_at <= ?").all(orgId, span.from, span.to);
    const engagement = posts.reduce((sum, post) => sum + post.likes + post.comments_count + post.shares, 0);
    const labels = { positive: 0, negative: 0, neutral: 0 };
    let score = 0;
    const byDay = new Map();
    const byPlatform = new Map();
    for (const post of posts) {
      labels[post.sentiment_label] = (labels[post.sentiment_label] || 0) + 1;
      score += post.sentiment_score;
      const day = post.posted_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
      byPlatform.set(post.platform_code, (byPlatform.get(post.platform_code) || 0) + 1);
    }
    for (const comment of comments) byDay.set(comment.posted_at.slice(0, 10), (byDay.get(comment.posted_at.slice(0, 10)) || 0) + 1);
    const keywords = db.prepare("SELECT term FROM keywords WHERE organization_id = ? AND kind = 'include'").all(orgId);
    const keywordCounts = keywords.map((row) => ({
      term: row.term,
      mentions: posts.filter((post) => post.text.toLowerCase().includes(row.term.toLowerCase())).length,
    })).sort((a, b) => b.mentions - a.mentions).slice(0, 8);
    const influencerMap = new Map();
    for (const post of posts) {
      const key = `${post.platform_code}:${post.author_handle}`;
      const current = influencerMap.get(key) || { name: post.author_name, handle: post.author_handle, platform: post.platform_code, posts: 0, engagement: 0 };
      current.posts += 1;
      current.engagement += post.likes + post.comments_count + post.shares;
      influencerMap.set(key, current);
    }
    return send(res, 200, {
      from: span.fromDay,
      to: span.toDay,
      sample: true,
      live: false,
      mentions: posts.length + comments.length,
      posts: posts.length,
      comments: comments.length,
      engagement,
      sentiment: {
        average: posts.length ? Number((score / posts.length).toFixed(4)) : 0,
        ...labels,
      },
      mentionTrend: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, mentions]) => ({ day, mentions })),
      platforms: [...byPlatform.entries()].map(([platform, count]) => ({ platform, count })),
      keywords: keywordCounts,
      influencers: [...influencerMap.values()].sort((a, b) => b.engagement - a.engagement).slice(0, 8),
      competitors: compareCompetitors(db, orgId, span.from, span.to),
    });
  }

  if (method === "GET" && path === "/api/posts") {
    if (!requireUser(db, res, auth, "read")) return;
    const span = windowOf(url.searchParams);
    if (span.error) return send(res, 400, { error: span.error });
    let rows = postsIn(db, orgId, span.from, span.to);
    const platform = url.searchParams.get("platform") || "";
    const sentiment = url.searchParams.get("sentiment") || "";
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const projectId = url.searchParams.get("projectId") || "";
    if (platform) rows = rows.filter((row) => row.platform_code === platform);
    if (sentiment) rows = rows.filter((row) => row.sentiment_label === sentiment);
    if (q) rows = rows.filter((row) => `${row.text} ${row.author_name} ${row.author_handle}`.toLowerCase().includes(q));
    if (projectId) {
      const loaded = loadRules(db, orgId, projectId);
      if (!loaded) return send(res, 404, { error: "Project not found." });
      rows = rows.filter((row) => textMatches(row.text, loaded.rules));
    }
    const sort = url.searchParams.get("sort") || "date";
    const sorts = {
      date: (a, b) => b.posted_at.localeCompare(a.posted_at),
      date_asc: (a, b) => a.posted_at.localeCompare(b.posted_at),
      engagement: (a, b) => (b.likes + b.comments_count + b.shares) - (a.likes + a.comments_count + a.shares),
      sentiment: (a, b) => b.sentiment_score - a.sentiment_score,
      author: (a, b) => a.author_name.localeCompare(b.author_name),
    };
    rows.sort(sorts[sort] || sorts.date);
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("pageSize") || 10)));
    return send(res, 200, {
      items: rows.slice((page - 1) * pageSize, page * pageSize).map(publicPost),
      total: rows.length,
      page,
      pageSize,
      sample: true,
      live: false,
    });
  }

  const postMatch = path.match(/^\/api\/posts\/([a-f0-9]+)$/);
  if (method === "GET" && postMatch) {
    if (!requireUser(db, res, auth, "read")) return;
    const post = db.prepare("SELECT * FROM posts WHERE id = ? AND organization_id = ?").get(postMatch[1], orgId);
    if (!post) return send(res, 404, { error: "Post not found." });
    const comments = db.prepare("SELECT * FROM comments WHERE post_id = ? AND organization_id = ? ORDER BY posted_at").all(post.id, orgId);
    const sentiment = db.prepare("SELECT * FROM sentiment_results WHERE target_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1").get(post.id, orgId);
    return send(res, 200, {
      post: publicPost(post),
      comments: comments.map((row) => ({
        id: row.id, author: row.author_name, text: row.text, postedAt: row.posted_at,
        sentiment: row.sentiment_label, score: row.sentiment_score, sample: row.sample === 1, live: false,
      })),
      sentiment: sentiment || null,
      sample: true,
      live: false,
    });
  }

  if (method === "GET" && path === "/api/connectors") {
    if (!requireUser(db, res, auth, "read")) return;
    return send(res, 200, { connectors: listConnectors(), live: false });
  }

  if (method === "POST" && path === "/api/ingestion/run") {
    if (!requireUser(db, res, auth, "ingest")) return;
    const result = runConnector(body.connector);
    if (result.error) return send(res, result.status, { error: result.error });
    let inserted = 0;
    let crises = 0;
    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
    for (const item of result.items) {
      const exists = db.prepare("SELECT id FROM posts WHERE organization_id = ? AND platform_code = ? AND external_id = ?").get(orgId, item.platform, item.externalId);
      if (exists) continue;
      const scored = analyze(item.text);
      const id = newId();
      db.prepare(`INSERT INTO posts (
        id, organization_id, platform_code, external_id, author_name, author_handle, posted_at, url, text,
        language, likes, comments_count, shares, sentiment_label, sentiment_score, crisis_risk, sample, source, project_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, orgId, item.platform, item.externalId, item.authorName, item.authorHandle, item.postedAt, item.url, item.text,
        scored.language, item.likes, item.commentsCount, item.shares, scored.label, scored.score, scored.crisis_risk,
        item.sample ? 1 : 0, item.source, body.projectId || null, now,
      );
      saveSentiment(db, orgId, "post", id, scored);
      for (const comment of item.comments || []) {
        const commentScore = analyze(comment.text);
        db.prepare(`INSERT INTO comments (
          id, organization_id, post_id, author_name, text, posted_at, sentiment_label, sentiment_score, sample, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
          newId(), orgId, id, comment.authorName, comment.text, comment.postedAt, commentScore.label, commentScore.score, now,
        );
      }
      inserted += 1;
      if (scored.crisis_risk >= 0.5) crises += 1;
    }
    if (crises) {
      const members = db.prepare("SELECT user_id FROM memberships WHERE organization_id = ?").all(orgId);
      for (const member of members) {
        db.prepare("INSERT INTO notifications (id, organization_id, user_id, kind, title, body, created_at) VALUES (?, ?, ?, 'crisis', ?, ?, ?)").run(
          newId(), orgId, member.user_id, "Жишээ: эрсдэлтэй пост", "Sample ingestion stored a high crisis score. This is sample data.", now,
        );
      }
    }
    db.prepare("INSERT INTO ingestion_runs (id, organization_id, connector, status, sample, message, created_at) VALUES (?, ?, ?, 'ok', ?, ?, ?)").run(
      newId(), orgId, body.connector, result.sample ? 1 : 0, result.message, now,
    );
    db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "ingest", entity: "connector", detail: `${body.connector} inserted ${inserted}` });
    return send(res, 200, { ...result, inserted, live: false });
  }

  if (method === "GET" && path === "/api/projects") {
    if (!requireUser(db, res, auth, "read")) return;
    const projects = db.prepare("SELECT * FROM projects WHERE organization_id = ? ORDER BY name").all(orgId);
    return send(res, 200, {
      projects: projects.map((project) => ({
        ...project,
        keywords: db.prepare("SELECT id, term, kind FROM keywords WHERE project_id = ? AND organization_id = ?").all(project.id, orgId),
        conditions: db.prepare("SELECT id, bucket, term, position FROM boolean_conditions WHERE project_id = ? AND organization_id = ? ORDER BY position").all(project.id, orgId),
      })),
    });
  }

  if (method === "POST" && path === "/api/projects") {
    if (!requireUser(db, res, auth, "write")) return;
    const name = String(body.name || "").trim();
    if (!name) return send(res, 400, { error: "Project name is required." });
    const id = newId();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO projects (id, organization_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, orgId, name, String(body.description || ""), now, now,
    );
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "create", entity: "project", entityId: id });
    return send(res, 201, { id });
  }

  const projectMatch = path.match(/^\/api\/projects\/([a-f0-9]+)$/);
  if (projectMatch && method === "PATCH") {
    if (!requireUser(db, res, auth, "write")) return;
    const current = db.prepare("SELECT * FROM projects WHERE id = ? AND organization_id = ?").get(projectMatch[1], orgId);
    if (!current) return send(res, 404, { error: "Project not found." });
    db.prepare("UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(
      String(body.name || current.name).trim(), String(body.description ?? current.description), new Date().toISOString(), current.id,
    );
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "update", entity: "project", entityId: current.id });
    return send(res, 200, { ok: true });
  }
  if (projectMatch && method === "DELETE") {
    if (!requireUser(db, res, auth, "write")) return;
    const result = db.prepare("DELETE FROM projects WHERE id = ? AND organization_id = ?").run(projectMatch[1], orgId);
    if (!result.changes) return send(res, 404, { error: "Project not found." });
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "delete", entity: "project", entityId: projectMatch[1] });
    return send(res, 200, { ok: true });
  }

  const keywordPost = path.match(/^\/api\/projects\/([a-f0-9]+)\/keywords$/);
  if (keywordPost && method === "POST") {
    if (!requireUser(db, res, auth, "write")) return;
    const project = db.prepare("SELECT id FROM projects WHERE id = ? AND organization_id = ?").get(keywordPost[1], orgId);
    if (!project) return send(res, 404, { error: "Project not found." });
    const term = String(body.term || "").trim();
    const kind = body.kind === "exclude" ? "exclude" : "include";
    if (!term) return send(res, 400, { error: "Term is required." });
    const id = newId();
    db.prepare("INSERT INTO keywords (id, organization_id, project_id, term, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, orgId, project.id, term, kind, new Date().toISOString(),
    );
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "create", entity: "keyword", entityId: id });
    return send(res, 201, { id });
  }

  const keywordDelete = path.match(/^\/api\/keywords\/([a-f0-9]+)$/);
  if (keywordDelete && method === "DELETE") {
    if (!requireUser(db, res, auth, "write")) return;
    const result = db.prepare("DELETE FROM keywords WHERE id = ? AND organization_id = ?").run(keywordDelete[1], orgId);
    if (!result.changes) return send(res, 404, { error: "Keyword not found." });
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "delete", entity: "keyword", entityId: keywordDelete[1] });
    return send(res, 200, { ok: true });
  }

  const conditionPost = path.match(/^\/api\/projects\/([a-f0-9]+)\/conditions$/);
  if (conditionPost && method === "POST") {
    if (!requireUser(db, res, auth, "write")) return;
    const project = db.prepare("SELECT id FROM projects WHERE id = ? AND organization_id = ?").get(conditionPost[1], orgId);
    if (!project) return send(res, 404, { error: "Project not found." });
    const bucket = ["all", "any", "not"].includes(body.bucket) ? body.bucket : "";
    const term = String(body.term || "").trim();
    if (!bucket || !term) return send(res, 400, { error: "Bucket and term are required." });
    const position = db.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM boolean_conditions WHERE project_id = ?").get(project.id).p + 1;
    const id = newId();
    db.prepare("INSERT INTO boolean_conditions (id, organization_id, project_id, bucket, term, position) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, orgId, project.id, bucket, term, position,
    );
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "create", entity: "condition", entityId: id });
    return send(res, 201, { id });
  }

  const conditionDelete = path.match(/^\/api\/conditions\/([a-f0-9]+)$/);
  if (conditionDelete && method === "DELETE") {
    if (!requireUser(db, res, auth, "write")) return;
    const result = db.prepare("DELETE FROM boolean_conditions WHERE id = ? AND organization_id = ?").run(conditionDelete[1], orgId);
    if (!result.changes) return send(res, 404, { error: "Condition not found." });
    return send(res, 200, { ok: true });
  }

  const matchGet = path.match(/^\/api\/projects\/([a-f0-9]+)\/matches$/);
  if (matchGet && method === "GET") {
    if (!requireUser(db, res, auth, "read")) return;
    const loaded = loadRules(db, orgId, matchGet[1]);
    if (!loaded) return send(res, 404, { error: "Project not found." });
    const span = windowOf(url.searchParams);
    if (span.error) return send(res, 400, { error: span.error });
    let rows = postsIn(db, orgId, span.from, span.to).filter((row) => textMatches(row.text, loaded.rules));
    const platform = url.searchParams.get("platform") || "";
    if (platform) rows = rows.filter((row) => row.platform_code === platform);
    return send(res, 200, { total: rows.length, items: rows.map(publicPost), rules: loaded.rules, sample: true, live: false });
  }

  if (method === "GET" && path === "/api/trends") {
    if (!requireUser(db, res, auth, "read")) return;
    const span = windowOf(url.searchParams);
    if (span.error) return send(res, 400, { error: span.error });
    const prev = previousWindow(span.from, span.to);
    const topics = db.prepare("SELECT * FROM topics WHERE organization_id = ? ORDER BY name").all(orgId);
    return send(res, 200, {
      from: span.fromDay,
      to: span.toDay,
      sample: true,
      live: false,
      topics: topics.map((topic) => ({
        id: topic.id,
        name: topic.name,
        current: topicMetrics(db, orgId, topic.id, span.from, span.to),
        previous: topicMetrics(db, orgId, topic.id, prev.from, prev.to),
      })),
    });
  }

  if (method === "POST" && path === "/api/topics") {
    if (!requireUser(db, res, auth, "write")) return;
    const name = String(body.name || "").trim();
    if (!name) return send(res, 400, { error: "Topic name is required." });
    const id = newId();
    db.prepare("INSERT INTO topics (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)").run(id, orgId, name, new Date().toISOString());
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "create", entity: "topic", entityId: id });
    return send(res, 201, { id });
  }

  const topicDelete = path.match(/^\/api\/topics\/([a-f0-9]+)$/);
  if (topicDelete && method === "DELETE") {
    if (!requireUser(db, res, auth, "write")) return;
    const result = db.prepare("DELETE FROM topics WHERE id = ? AND organization_id = ?").run(topicDelete[1], orgId);
    if (!result.changes) return send(res, 404, { error: "Topic not found." });
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "delete", entity: "topic", entityId: topicDelete[1] });
    return send(res, 200, { ok: true });
  }

  const topicLink = path.match(/^\/api\/topics\/([a-f0-9]+)\/posts$/);
  if (topicLink && method === "POST") {
    if (!requireUser(db, res, auth, "write")) return;
    const topic = db.prepare("SELECT id FROM topics WHERE id = ? AND organization_id = ?").get(topicLink[1], orgId);
    const post = db.prepare("SELECT id FROM posts WHERE id = ? AND organization_id = ?").get(String(body.postId || ""), orgId);
    if (!topic || !post) return send(res, 404, { error: "Topic or post not found." });
    db.prepare("INSERT OR IGNORE INTO topic_posts (topic_id, post_id, organization_id) VALUES (?, ?, ?)").run(topic.id, post.id, orgId);
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && path === "/api/sentiment/analyze") {
    if (!requireUser(db, res, auth, "read")) return;
    const text = String(body.text || "").trim();
    if (!text) return send(res, 400, { error: "Text is required." });
    const scored = analyze(text);
    const id = newId();
    saveSentiment(db, orgId, "ad-hoc", id, scored);
    return send(res, 200, { id, ...scored, engine: "local-lexicon", liveModel: false });
  }

  if (method === "GET" && path === "/api/sentiment") {
    if (!requireUser(db, res, auth, "read")) return;
    const span = windowOf(url.searchParams);
    if (span.error) return send(res, 400, { error: span.error });
    const rows = db.prepare(`SELECT * FROM sentiment_results WHERE organization_id = ? AND target_type = 'post' AND created_at >= ?`).all(orgId, "1970-01-01");
    const posts = postsIn(db, orgId, span.from, span.to);
    const summary = { positive: 0, negative: 0, neutral: 0, complaint: 0, satisfaction: 0, product_feedback: 0, brand_perception: 0, mn: 0, en: 0 };
    const crises = [];
    for (const post of posts) {
      summary[post.sentiment_label] = (summary[post.sentiment_label] || 0) + 1;
      summary[post.language] = (summary[post.language] || 0) + 1;
      const detail = db.prepare("SELECT * FROM sentiment_results WHERE target_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1").get(post.id, orgId);
      if (detail) {
        summary.complaint += detail.complaint;
        summary.satisfaction += detail.satisfaction;
        summary.product_feedback += detail.product_feedback;
        summary.brand_perception += detail.brand_perception;
      }
      if (post.crisis_risk >= 0.5) crises.push(publicPost(post));
    }
    return send(res, 200, { summary, crises, storedResults: rows.length, engine: "local-lexicon", liveModel: false, sample: true });
  }

  if (method === "GET" && path === "/api/competitors") {
    if (!requireUser(db, res, auth, "read")) return;
    const rows = db.prepare("SELECT * FROM competitors WHERE organization_id = ? ORDER BY name").all(orgId);
    return send(res, 200, {
      competitors: rows.map((row) => ({
        ...row,
        terms: db.prepare("SELECT id, term FROM competitor_terms WHERE competitor_id = ? AND organization_id = ?").all(row.id, orgId),
      })),
    });
  }

  if (method === "POST" && path === "/api/competitors") {
    if (!requireUser(db, res, auth, "write")) return;
    const name = String(body.name || "").trim();
    if (!name) return send(res, 400, { error: "Name is required." });
    const id = newId();
    db.prepare("INSERT INTO competitors (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)").run(id, orgId, name, new Date().toISOString());
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "create", entity: "competitor", entityId: id });
    return send(res, 201, { id });
  }

  const competitorDelete = path.match(/^\/api\/competitors\/([a-f0-9]+)$/);
  if (competitorDelete && method === "DELETE") {
    if (!requireUser(db, res, auth, "write")) return;
    const result = db.prepare("DELETE FROM competitors WHERE id = ? AND organization_id = ?").run(competitorDelete[1], orgId);
    if (!result.changes) return send(res, 404, { error: "Competitor not found." });
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "delete", entity: "competitor", entityId: competitorDelete[1] });
    return send(res, 200, { ok: true });
  }

  const termPost = path.match(/^\/api\/competitors\/([a-f0-9]+)\/terms$/);
  if (termPost && method === "POST") {
    if (!requireUser(db, res, auth, "write")) return;
    const competitor = db.prepare("SELECT id FROM competitors WHERE id = ? AND organization_id = ?").get(termPost[1], orgId);
    if (!competitor) return send(res, 404, { error: "Competitor not found." });
    const term = String(body.term || "").trim();
    if (!term) return send(res, 400, { error: "Term is required." });
    const id = newId();
    db.prepare("INSERT INTO competitor_terms (id, organization_id, competitor_id, term) VALUES (?, ?, ?, ?)").run(id, orgId, competitor.id, term);
    return send(res, 201, { id });
  }

  const termDelete = path.match(/^\/api\/competitor-terms\/([a-f0-9]+)$/);
  if (termDelete && method === "DELETE") {
    if (!requireUser(db, res, auth, "write")) return;
    const result = db.prepare("DELETE FROM competitor_terms WHERE id = ? AND organization_id = ?").run(termDelete[1], orgId);
    if (!result.changes) return send(res, 404, { error: "Term not found." });
    return send(res, 200, { ok: true });
  }

  if (method === "GET" && path === "/api/competitors/compare") {
    if (!requireUser(db, res, auth, "read")) return;
    const span = windowOf(url.searchParams);
    if (span.error) return send(res, 400, { error: span.error });
    const comparison = compareCompetitors(db, orgId, span.from, span.to);
    const topics = db.prepare("SELECT * FROM topics WHERE organization_id = ?").all(orgId);
    const topicOverlap = topics.map((topic) => {
      const posts = db.prepare(`SELECT p.text FROM posts p JOIN topic_posts tp ON tp.post_id = p.id
        WHERE tp.topic_id = ? AND p.organization_id = ? AND p.posted_at >= ? AND p.posted_at <= ?`).all(topic.id, orgId, span.from, span.to);
      const shares = comparison.competitors.map((competitor) => ({
        competitorId: competitor.id,
        name: competitor.name,
        mentions: posts.filter((post) => competitor.terms.some((term) => post.text.toLowerCase().includes(term.toLowerCase()))).length,
      }));
      return { topic: topic.name, shares };
    });
    return send(res, 200, { ...comparison, topicOverlap });
  }

  if (method === "GET" && path === "/api/reports") {
    if (!requireUser(db, res, auth, "read")) return;
    const reports = db.prepare("SELECT * FROM reports WHERE organization_id = ? ORDER BY created_at DESC").all(orgId);
    return send(res, 200, { reports });
  }

  if (method === "POST" && path === "/api/reports") {
    if (!requireUser(db, res, auth, "export")) return;
    const name = String(body.name || "").trim();
    const cadence = ["daily", "weekly", "monthly"].includes(body.cadence) ? body.cadence : "";
    const span = windowOf(new URLSearchParams({ from: body.from || "", to: body.to || "" }));
    if (!name || !cadence || span.error || !body.from || !body.to) return send(res, 400, { error: span.error || "Name, cadence, from, and to are required." });
    const id = newId();
    db.prepare("INSERT INTO reports (id, organization_id, name, cadence, date_from, date_to, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id, orgId, name, cadence, body.from, body.to, auth.user.id, new Date().toISOString(),
    );
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "create", entity: "report", entityId: id });
    return send(res, 201, { id });
  }

  const reportFile = path.match(/^\/api\/reports\/([a-f0-9]+)\.(xlsx|pdf)$/);
  if (reportFile && method === "GET") {
    if (!requireUser(db, res, auth, "export")) return;
    const report = db.prepare("SELECT * FROM reports WHERE id = ? AND organization_id = ?").get(reportFile[1], orgId);
    if (!report) return send(res, 404, { error: "Report not found." });
    const span = windowOf(new URLSearchParams({ from: report.date_from, to: report.date_to }));
    const posts = postsIn(db, orgId, span.from, span.to);
    const buckets = new Map();
    for (const post of posts) {
      const key = cadenceKey(post.posted_at, report.cadence);
      const current = buckets.get(key) || { bucket: key, mentions: 0, engagement: 0 };
      current.mentions += 1;
      current.engagement += post.likes + post.comments_count + post.shares;
      buckets.set(key, current);
    }
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "export", entity: "report", entityId: report.id, detail: reportFile[2] });
    if (reportFile[2] === "xlsx") {
      const summary = [
        ["field", "value"],
        ["name", report.name],
        ["organization", auth.organization.name],
        ["cadence", report.cadence],
        ["from", report.date_from],
        ["to", report.date_to],
        ["notice", "SAMPLE DATA. Not a live social feed."],
        ["bucket", "mentions", "engagement"],
        ...[...buckets.values()].map((row) => [row.bucket, row.mentions, row.engagement]),
      ];
      const table = [["platform", "author", "date", "url", "text", "engagement", "sentiment", "sample"], ...posts.map((post) => [
        post.platform_code, post.author_name, post.posted_at, post.url, post.text,
        post.likes + post.comments_count + post.shares, post.sentiment_label, post.sample ? "sample" : "not-sample",
      ])];
      const file = buildXlsx(summary, table);
      return send(res, 200, file, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="report-${report.id}.xlsx"`,
      });
    }
    const rows = posts.map((post) => `<tr><td>${escapeHtml(post.platform_code)}</td><td>${escapeHtml(post.author_name)}</td><td>${escapeHtml(post.posted_at.slice(0, 10))}</td><td>${escapeHtml(post.sentiment_label)}</td><td>${escapeHtml(post.text)}</td></tr>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{font-family:sans-serif;color:#0f172a} h1{font-size:20px} .banner{background:#fff7ed;border:1px solid #fdba74;padding:8px 12px}
      table{border-collapse:collapse;width:100%;font-size:12px} td,th{border:1px solid #cbd5e1;padding:4px 6px;text-align:left}
    </style></head><body>
      <p class="banner">Жишээ өгөгдөл / SAMPLE DATA. Not a live feed.</p>
      <h1>${escapeHtml(report.name)}</h1>
      <p>${escapeHtml(auth.organization.name)} · ${escapeHtml(report.cadence)} · ${escapeHtml(report.date_from)} – ${escapeHtml(report.date_to)}</p>
      <table><thead><tr><th>Platform</th><th>Author</th><th>Date</th><th>Sentiment</th><th>Text</th></tr></thead><tbody>${rows}</tbody></table>
    </body></html>`;
    const pdf = await htmlToPdf(html, [
      "SAMPLE DATA. Not a live social feed.",
      report.name,
      `${auth.organization.name} ${report.date_from} ${report.date_to}`,
      "Chrome was unavailable. Mongolian text is in the Excel file.",
    ]);
    return send(res, 200, pdf, {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="report-${report.id}.pdf"`,
    });
  }

  if (method === "GET" && path === "/api/notifications") {
    if (!requireUser(db, res, auth, "read")) return;
    const rows = db.prepare(`SELECT * FROM notifications WHERE organization_id = ? AND (user_id = ? OR user_id IS NULL)
      ORDER BY created_at DESC LIMIT 50`).all(orgId, auth.user.id);
    return send(res, 200, {
      unread: rows.filter((row) => !row.read_at).length,
      notifications: rows,
    });
  }

  const noteRead = path.match(/^\/api\/notifications\/([a-f0-9]+)\/read$/);
  if (noteRead && method === "POST") {
    if (!requireUser(db, res, auth, "read")) return;
    const result = db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND organization_id = ? AND (user_id = ? OR user_id IS NULL)").run(
      new Date().toISOString(), noteRead[1], orgId, auth.user.id,
    );
    if (!result.changes) return send(res, 404, { error: "Notification not found." });
    return send(res, 200, { ok: true });
  }

  if (method === "GET" && path === "/api/members") {
    if (!requireUser(db, res, auth, "read")) return;
    const members = db.prepare(`SELECT m.id, m.role, m.created_at, u.id AS user_id, u.email, u.name
      FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY u.name`).all(orgId);
    return send(res, 200, { members });
  }

  if (method === "POST" && path === "/api/members") {
    if (!requireUser(db, res, auth, "members")) return;
    const email = String(body.email || "").trim().toLowerCase();
    const role = String(body.role || "");
    if (!["owner", "admin", "analyst", "viewer"].includes(role)) return send(res, 400, { error: "Unknown role." });
    if (role === "owner" && auth.membership.role !== "owner") return deny(db, res, auth, "manage");
    if (!email.includes("@")) return send(res, 400, { error: "Email is required." });
    let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    const now = new Date().toISOString();
    if (!user) {
      const name = String(body.name || "").trim();
      const password = String(body.password || "");
      if (!name || password.length < 8) return send(res, 400, { error: "New members need a name and a password of at least 8 characters." });
      user = { id: newId() };
      db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
        user.id, email, name, hashPassword(password), now,
      );
    }
    if (db.prepare("SELECT id FROM memberships WHERE organization_id = ? AND user_id = ?").get(orgId, user.id)) {
      return send(res, 409, { error: "That person is already a member." });
    }
    const id = newId();
    db.prepare("INSERT INTO memberships (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)").run(id, orgId, user.id, role, now);
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "create", entity: "membership", entityId: id, detail: role });
    return send(res, 201, { id });
  }

  const memberPatch = path.match(/^\/api\/members\/([a-f0-9]+)$/);
  if (memberPatch && method === "PATCH") {
    if (!requireUser(db, res, auth, "members")) return;
    const membership = db.prepare("SELECT * FROM memberships WHERE id = ? AND organization_id = ?").get(memberPatch[1], orgId);
    if (!membership) return send(res, 404, { error: "Member not found." });
    const role = String(body.role || "");
    if (!["owner", "admin", "analyst", "viewer"].includes(role)) return send(res, 400, { error: "Unknown role." });
    if ((role === "owner" || membership.role === "owner") && auth.membership.role !== "owner") return deny(db, res, auth, "manage");
    if (membership.role === "owner" && role !== "owner") {
      const owners = db.prepare("SELECT COUNT(*) AS c FROM memberships WHERE organization_id = ? AND role = 'owner'").get(orgId).c;
      if (owners < 2) return send(res, 409, { error: "The last owner cannot be demoted." });
    }
    db.prepare("UPDATE memberships SET role = ? WHERE id = ?").run(role, membership.id);
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "update", entity: "membership", entityId: membership.id, detail: role });
    return send(res, 200, { ok: true });
  }
  if (memberPatch && method === "DELETE") {
    if (!requireUser(db, res, auth, "members")) return;
    const membership = db.prepare("SELECT * FROM memberships WHERE id = ? AND organization_id = ?").get(memberPatch[1], orgId);
    if (!membership) return send(res, 404, { error: "Member not found." });
    if (membership.role === "owner") {
      const owners = db.prepare("SELECT COUNT(*) AS c FROM memberships WHERE organization_id = ? AND role = 'owner'").get(orgId).c;
      if (owners < 2) return send(res, 409, { error: "The last owner cannot be removed." });
    }
    db.prepare("DELETE FROM memberships WHERE id = ?").run(membership.id);
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "delete", entity: "membership", entityId: membership.id });
    return send(res, 200, { ok: true });
  }

  if (method === "GET" && path === "/api/audit") {
    if (!requireUser(db, res, auth, "audit")) return;
    const rows = db.prepare("SELECT * FROM audit_logs WHERE organization_id = ? ORDER BY created_at DESC LIMIT 100").all(orgId);
    return send(res, 200, { logs: rows });
  }

  if (method === "PATCH" && path === "/api/organization") {
    if (!requireUser(db, res, auth, "manage")) return;
    const name = String(body.name || "").trim();
    if (!name) return send(res, 400, { error: "Name is required." });
    db.prepare("UPDATE organizations SET name = ? WHERE id = ?").run(name, orgId);
    audit(db, { organizationId: orgId, userId: auth.user.id, action: "update", entity: "organization", entityId: orgId });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "Not found." });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

const FILES = {
  "/": "index.html",
  "/login": "login.html",
  "/register": "register.html",
  "/forgot": "forgot.html",
  "/app": "app.html",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveStatic(res, staticDir, pathname) {
  const mapped = FILES[pathname] || pathname.replace(/^\/+/, "");
  const root = resolve(staticDir);
  const file = resolve(root, normalize(mapped));
  if (!file.startsWith(root) || !existsSync(file)) {
    send(res, 404, { error: "Not found." });
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(body);
}

export function createApp(options = {}) {
  const dbPath = options.dbPath || join(HERE, "data", "si.db");
  const staticDir = options.staticDir || join(HERE, "..", "platform");
  const db = openDatabase(dbPath);
  let chain = Promise.resolve();
  const server = createServer((req, res) => {
    const run = chain.then(async () => {
      const origin = req.headers.origin;
      if (origin) {
        const host = req.headers.host || "";
        if (new URL(origin).host !== host) return send(res, 403, { error: "Origin rejected." });
      }
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, db, url);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed." });
      serveStatic(res, staticDir, url.pathname);
    });
    chain = run.then(() => {}, () => {});
    run.catch((error) => {
      const status = error.status || 500;
      if (!res.headersSent) send(res, status, { error: status === 500 ? "Server error." : error.message });
    });
  });
  return {
    server,
    db,
    close() {
      db.close();
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const app = createApp();
  const port = Number(process.env.PORT || 8787);
  app.server.listen(port, "127.0.0.1", () => {
    console.log(`Social intelligence listening on http://127.0.0.1:${port}`);
  });
}
