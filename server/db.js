import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashPassword, newId } from "./auth.js";
import { analyze } from "./sentiment.js";

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','analyst','viewer')),
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keywords (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('include','exclude')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS keywords_project ON keywords(organization_id, project_id);

CREATE TABLE IF NOT EXISTS boolean_conditions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL CHECK (bucket IN ('all','any','not')),
  term TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS boolean_project ON boolean_conditions(organization_id, project_id);

CREATE TABLE IF NOT EXISTS platforms (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  official_status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  platform_code TEXT NOT NULL,
  external_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  url TEXT NOT NULL,
  text TEXT NOT NULL,
  language TEXT NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  sentiment_label TEXT NOT NULL,
  sentiment_score REAL NOT NULL,
  crisis_risk REAL NOT NULL DEFAULT 0,
  sample INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, platform_code, external_id)
);
CREATE INDEX IF NOT EXISTS posts_org_date ON posts(organization_id, posted_at);
CREATE INDEX IF NOT EXISTS posts_org_platform ON posts(organization_id, platform_code);
CREATE INDEX IF NOT EXISTS posts_org_sentiment ON posts(organization_id, sentiment_label);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  text TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  sentiment_label TEXT NOT NULL,
  sentiment_score REAL NOT NULL,
  sample INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_post ON comments(organization_id, post_id);

CREATE TABLE IF NOT EXISTS sentiment_results (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  language TEXT NOT NULL,
  label TEXT NOT NULL,
  score REAL NOT NULL,
  complaint INTEGER NOT NULL,
  satisfaction INTEGER NOT NULL,
  product_feedback INTEGER NOT NULL,
  brand_perception INTEGER NOT NULL,
  crisis_risk REAL NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topic_posts (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, post_id)
);

CREATE TABLE IF NOT EXISTS competitors (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competitor_terms (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  term TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly','monthly')),
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(organization_id, user_id, read_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_org_date ON audit_logs(organization_id, created_at);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connector TEXT NOT NULL,
  status TEXT NOT NULL,
  sample INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function isoDaysAgo(days, hours = 12) {
  const date = new Date();
  date.setUTCHours(hours, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

function insertPost(db, orgId, projectId, row) {
  const scored = analyze(row.text);
  const id = newId();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO posts (
    id, organization_id, platform_code, external_id, author_name, author_handle,
    posted_at, url, text, language, likes, comments_count, shares,
    sentiment_label, sentiment_score, crisis_risk, sample, source, project_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`).run(
    id, orgId, row.platform, row.externalId, row.author, row.handle,
    row.postedAt, row.url, row.text, scored.language, row.likes, row.comments, row.shares,
    scored.label, scored.score, scored.crisis_risk, projectId, now,
  );
  db.prepare(`INSERT INTO sentiment_results (
    id, organization_id, target_type, target_id, language, label, score,
    complaint, satisfaction, product_feedback, brand_perception, crisis_risk, summary, created_at
  ) VALUES (?, ?, 'post', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newId(), orgId, id, scored.language, scored.label, scored.score,
    scored.complaint, scored.satisfaction, scored.product_feedback, scored.brand_perception,
    scored.crisis_risk, scored.summary, now,
  );
  return { id, scored };
}

function seedOrg(db, spec) {
  const now = new Date().toISOString();
  const orgId = newId();
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)").run(orgId, spec.name, now);
  const userIds = {};
  for (const user of spec.users) {
    const id = newId();
    userIds[user.email] = id;
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id, user.email, user.name, hashPassword(user.password), now,
    );
    db.prepare("INSERT INTO memberships (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)").run(
      newId(), orgId, id, user.role, now,
    );
  }
  let projectId = null;
  if (spec.project) {
    projectId = newId();
    db.prepare("INSERT INTO projects (id, organization_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      projectId, orgId, spec.project.name, spec.project.description, now, now,
    );
    for (const term of spec.project.include || []) {
      db.prepare("INSERT INTO keywords (id, organization_id, project_id, term, kind, created_at) VALUES (?, ?, ?, ?, 'include', ?)").run(
        newId(), orgId, projectId, term, now,
      );
    }
    for (const term of spec.project.exclude || []) {
      db.prepare("INSERT INTO keywords (id, organization_id, project_id, term, kind, created_at) VALUES (?, ?, ?, ?, 'exclude', ?)").run(
        newId(), orgId, projectId, term, now,
      );
    }
  }
  const topicIds = {};
  for (const name of spec.topics || []) {
    const id = newId();
    topicIds[name] = id;
    db.prepare("INSERT INTO topics (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)").run(id, orgId, name, now);
  }
  const postIds = {};
  for (const row of spec.posts) {
    const inserted = insertPost(db, orgId, projectId, row);
    postIds[row.externalId] = inserted.id;
    for (const topic of row.topics || []) {
      if (topicIds[topic]) {
        db.prepare("INSERT INTO topic_posts (topic_id, post_id, organization_id) VALUES (?, ?, ?)").run(
          topicIds[topic], inserted.id, orgId,
        );
      }
    }
    for (const comment of row.commentList || []) {
      const scored = analyze(comment);
      db.prepare(`INSERT INTO comments (
        id, organization_id, post_id, author_name, text, posted_at, sentiment_label, sentiment_score, sample, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
        newId(), orgId, inserted.id, "Жишээ уншигч", comment, row.postedAt, scored.label, scored.score, now,
      );
    }
  }
  for (const competitor of spec.competitors || []) {
    const id = newId();
    db.prepare("INSERT INTO competitors (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)").run(
      id, orgId, competitor.name, now,
    );
    for (const term of competitor.terms) {
      db.prepare("INSERT INTO competitor_terms (id, organization_id, competitor_id, term) VALUES (?, ?, ?, ?)").run(
        newId(), orgId, id, term,
      );
    }
  }
  if (spec.notice) {
    for (const user of spec.users) {
      db.prepare(`INSERT INTO notifications (id, organization_id, user_id, kind, title, body, created_at)
        VALUES (?, ?, ?, 'crisis', ?, ?, ?)`).run(
        newId(), orgId, userIds[user.email], spec.notice.title, spec.notice.body, now,
      );
    }
  }
  db.prepare(`INSERT INTO audit_logs (id, organization_id, user_id, action, entity, entity_id, detail, created_at)
    VALUES (?, ?, NULL, 'seed', 'organization', ?, 'Sample organization created', ?)`).run(
    newId(), orgId, orgId, now,
  );
}

function seed(db) {
  const count = db.prepare("SELECT COUNT(*) AS c FROM organizations").get().c;
  if (count > 0) return;
  const now = new Date().toISOString();
  const platforms = [
    ["facebook", "Facebook"],
    ["x", "X"],
    ["instagram", "Instagram"],
    ["threads", "Threads"],
    ["youtube", "YouTube"],
    ["web", "Web"],
  ];
  for (const [code, name] of platforms) {
    db.prepare("INSERT OR IGNORE INTO platforms (code, name, official_status, created_at) VALUES (?, ?, 'unavailable', ?)").run(
      code, name, now,
    );
  }
  seedOrg(db, {
    name: "Жишээ Альфа",
    users: [
      { email: "owner.alpha@sample.local", name: "Альфа эзэн", role: "owner", password: "SampleOwner!84" },
      { email: "analyst.alpha@sample.local", name: "Альфа шинжээч", role: "analyst", password: "SampleAnalyst!84" },
      { email: "viewer.alpha@sample.local", name: "Альфа үзэгч", role: "viewer", password: "SampleViewer!84" },
    ],
    project: {
      name: "Сарнай кофе",
      description: "Жишээ түлхүүр үгийн төсөл. Бодит брэнд биш.",
      include: ["сарнай", "sarnai"],
      exclude: ["ажлын зар"],
    },
    topics: ["Кофены чанар", "Үйлчилгээ", "Өрсөлдөгч"],
    competitors: [
      { name: "Алтан аяга", terms: ["алтан аяга"] },
      { name: "Номин талх", terms: ["номин талх"] },
    ],
    notice: {
      title: "Жишээ: сөрөг огшилт",
      body: "Жишээ өгөгдөл дээр скандалын түлхүүр үг илэрсэн. Энэ бол жишээ мэдэгдэл.",
    },
    posts: [
      { platform: "facebook", externalId: "seed-a-1", author: "Тэгшбаяр", handle: "tegsh.sample", days: 1, likes: 120, comments: 14, shares: 6, topics: ["Кофены чанар"], text: "Сарнай кофены шинэ амт үнэхээр гоё. Баярлалаа, чанар сайхан.", url: "https://example.local/sample/a/1", commentList: ["Би ч бас дуртай, сайхан амттай."] },
      { platform: "facebook", externalId: "seed-a-2", author: "Сараа", handle: "saraa.sample", days: 1, likes: 30, comments: 8, shares: 2, topics: ["Үйлчилгээ"], text: "Сарнай кофены үйлчилгээ муу, удаан. Гомдол гаргана. Сэтгэл дундуур.", url: "https://example.local/sample/a/2", commentList: ["Үйлчилгээ муу гэж би ч бодсон."] },
      { platform: "x", externalId: "seed-a-3", author: "Мэдээ", handle: "medee.sample", days: 0, likes: 210, comments: 40, shares: 33, topics: ["Өрсөлдөгч"], text: "Сарнай кофе скандал: олон нийтийн дургүйцэл, бойкот яригдаж байна.", url: "https://example.local/sample/a/3" },
      { platform: "instagram", externalId: "seed-a-4", author: "Anu", handle: "anu.sample", days: 2, likes: 300, comments: 22, shares: 11, topics: ["Кофены чанар"], text: "The Sarnai roast is excellent and I love the quality.", url: "https://example.local/sample/a/4" },
      { platform: "youtube", externalId: "seed-a-5", author: "Studio", handle: "studio.sample", days: 3, likes: 90, comments: 15, shares: 4, topics: ["Кофены чанар"], text: "Product review of Sarnai: reliable quality, I love the brand trust.", url: "https://example.local/sample/a/5" },
      { platform: "threads", externalId: "seed-a-6", author: "Эрдэнэ", handle: "erdene.sample", days: 4, likes: 18, comments: 3, shares: 1, topics: ["Кофены чанар"], text: "Сарнай кофены бүтээгдэхүүн чанаргүй. Дахиж авахгүй.", url: "https://example.local/sample/a/6" },
      { platform: "web", externalId: "seed-a-7", author: "Тойм", handle: "toim.sample", days: 5, likes: 12, comments: 1, shares: 2, topics: ["Кофены чанар"], text: "Сарнай брэнд нэр хүнд сайн. Хэрэглэгчид итгэлтэй байна.", url: "https://example.local/sample/a/7" },
      { platform: "facebook", externalId: "seed-a-8", author: "Тэгшбаяр", handle: "tegsh.sample", days: 6, likes: 64, comments: 5, shares: 3, topics: ["Үйлчилгээ"], text: "Сарнай кофе дээр сэтгэл хангалуун, дахин авна.", url: "https://example.local/sample/a/8" },
      { platform: "x", externalId: "seed-a-9", author: "Оюун", handle: "oyun.sample", days: 7, likes: 44, comments: 6, shares: 2, topics: ["Өрсөлдөгч"], text: "Алтан аяга өнөөдөр удаан байлаа. Үйлчилгээ муу.", url: "https://example.local/sample/a/9" },
      { platform: "instagram", externalId: "seed-a-10", author: "Anu", handle: "anu.sample", days: 8, likes: 150, comments: 12, shares: 7, topics: ["Өрсөлдөгч"], text: "Алтан аяга шинэ амт гоё, чанар сайхан.", url: "https://example.local/sample/a/10" },
      { platform: "facebook", externalId: "seed-a-11", author: "Номин", handle: "nomin.sample", days: 9, likes: 28, comments: 4, shares: 1, topics: ["Өрсөлдөгч"], text: "Номин талхны үнэ өндөр, амт муу.", url: "https://example.local/sample/a/11" },
      { platform: "web", externalId: "seed-a-12", author: "Тойм", handle: "toim.sample", days: 10, likes: 16, comments: 2, shares: 1, topics: ["Өрсөлдөгч"], text: "Номин талх брэнд итгэл муутай, гомдол их байна.", url: "https://example.local/sample/a/12" },
      { platform: "youtube", externalId: "seed-a-13", author: "Studio", handle: "studio.sample", days: 11, likes: 70, comments: 9, shares: 3, topics: ["Кофены чанар"], text: "Sarnai coffee quality is wonderful and the product is reliable.", url: "https://example.local/sample/a/13" },
      { platform: "threads", externalId: "seed-a-14", author: "Эрдэнэ", handle: "erdene.sample", days: 12, likes: 9, comments: 1, shares: 0, topics: ["Үйлчилгээ"], text: "Сарнай кофены салбар өнөөдөр сайхан угтлаа.", url: "https://example.local/sample/a/14" },
      { platform: "facebook", externalId: "seed-a-15", author: "Сараа", handle: "saraa.sample", days: 2, likes: 41, comments: 7, shares: 2, topics: ["Үйлчилгээ"], text: "Сарнай кофе ажлын зар биш. Энэ пост хасагдах ёстой.", url: "https://example.local/sample/a/15" },
      { platform: "x", externalId: "seed-a-16", author: "Мэдээ", handle: "medee.sample", days: 13, likes: 55, comments: 10, shares: 4, topics: ["Кофены чанар"], text: "Sarnai fans say the taste is excellent.", url: "https://example.local/sample/a/16" },
    ].map((row) => ({ ...row, postedAt: isoDaysAgo(row.days, 9 + (row.days % 5)) })),
  });
  seedOrg(db, {
    name: "Жишээ Бета",
    users: [
      { email: "owner.beta@sample.local", name: "Бета эзэн", role: "owner", password: "SampleOther!84" },
    ],
    project: {
      name: "Хөх тэнгэр",
      description: "Өөр байгууллагын жишээ төсөл.",
      include: ["хөх тэнгэр"],
      exclude: [],
    },
    topics: ["Аялал"],
    competitors: [{ name: "Жишээ өрсөлдөгч", terms: ["бороо тур"] }],
    posts: [
      { platform: "facebook", externalId: "seed-b-1", author: "Батаа", handle: "bataa.sample", days: 1, likes: 20, comments: 2, shares: 1, topics: ["Аялал"], text: "Хөх тэнгэр аялал сайхан боллоо. Баярлалаа.", url: "https://example.local/sample/b/1" },
      { platform: "web", externalId: "seed-b-2", author: "Батаа", handle: "bataa.sample", days: 3, likes: 8, comments: 1, shares: 0, topics: ["Аялал"], text: "Хөх тэнгэр үйлчилгээ муу байсан. Гомдолтой.", url: "https://example.local/sample/b/2" },
      { platform: "instagram", externalId: "seed-b-3", author: "Delger", handle: "delger.sample", days: 4, likes: 33, comments: 4, shares: 1, topics: ["Аялал"], text: "Khukh tenger trip was excellent and I love the guide.", url: "https://example.local/sample/b/3" },
    ].map((row) => ({ ...row, postedAt: isoDaysAgo(row.days, 11) })),
  });
}

export function openDatabase(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  const seedOn = process.env.DEMO_SEED !== "0";
  if (seedOn) {
    db.exec("BEGIN");
    try {
      seed(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } else {
    const now = new Date().toISOString();
    for (const [code, name] of [["facebook", "Facebook"], ["x", "X"], ["instagram", "Instagram"], ["threads", "Threads"], ["youtube", "YouTube"], ["web", "Web"]]) {
      db.prepare("INSERT OR IGNORE INTO platforms (code, name, official_status, created_at) VALUES (?, ?, 'unavailable', ?)").run(code, name, now);
    }
  }
  return db;
}

export function audit(db, { organizationId = null, userId = null, action, entity, entityId = null, detail = "" }) {
  db.prepare(`INSERT INTO audit_logs (id, organization_id, user_id, action, entity, entity_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newId(), organizationId, userId, action, entity, entityId, detail, new Date().toISOString(),
  );
}

export function saveSentiment(db, organizationId, targetType, targetId, scored) {
  db.prepare(`INSERT INTO sentiment_results (
    id, organization_id, target_type, target_id, language, label, score,
    complaint, satisfaction, product_feedback, brand_perception, crisis_risk, summary, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newId(), organizationId, targetType, targetId, scored.language, scored.label, scored.score,
    scored.complaint, scored.satisfaction, scored.product_feedback, scored.brand_perception,
    scored.crisis_risk, scored.summary, new Date().toISOString(),
  );
}
