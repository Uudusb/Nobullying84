import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, before, after } from "node:test";
import { createApp } from "../server/index.js";
import { analyze } from "../server/sentiment.js";

const dir = mkdtempSync(join(tmpdir(), "si-test-"));
const app = createApp({ dbPath: join(dir, "test.db") });
let base = "";

function client() {
  let cookie = "";
  return async function call(path, options = {}) {
    const res = await fetch(base + path, {
      method: options.method || "GET",
      headers: { "content-type": "application/json", cookie },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    if (setCookie.length) cookie = setCookie.map((row) => row.split(";")[0]).join("; ");
    else if (res.headers.get("set-cookie")) cookie = res.headers.get("set-cookie").split(";")[0];
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get("content-type") || "";
    let data = buf;
    if (type.includes("json")) data = JSON.parse(buf.toString("utf8") || "{}");
    return { status: res.status, data, buf };
  };
}

before(async () => {
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.server.close();
  app.close();
});

describe("social intelligence", { concurrency: 1 }, () => {
  test("local sentiment covers Mongolian and English", () => {
    const complaint = analyze("Сарнай кофены үйлчилгээ муу, удаан. Гомдол гаргана.");
    assert.equal(complaint.language, "mn");
    assert.equal(complaint.label, "negative");
    assert.equal(complaint.complaint, 1);
    const happy = analyze("The new roast is excellent and I love the quality.");
    assert.equal(happy.language, "en");
    assert.equal(happy.label, "positive");
    const crisis = analyze("This scandal calls for a boycott. Terrible service and public outrage.");
    assert.ok(crisis.crisis_risk >= 0.75);
    assert.equal(crisis.label, "negative");
  });

  test("sample owner can sign in and see only sample rows", async () => {
    const api = client();
    const bad = await api("/api/auth/login", { method: "POST", body: { email: "owner.alpha@sample.local", password: "nope" } });
    assert.equal(bad.status, 401);
    const ok = await api("/api/auth/login", { method: "POST", body: { email: "owner.alpha@sample.local", password: "SampleOwner!84" } });
    assert.equal(ok.status, 200);
    const me = await api("/api/auth/me");
    assert.equal(me.data.user.organization.name, "Жишээ Альфа");
    assert.equal(me.data.user.role, "owner");
    assert.equal(me.data.liveConnectors, false);
    const dash = await api("/api/dashboard");
    assert.ok(dash.data.posts >= 10);
    assert.ok(dash.data.mentions >= dash.data.posts);
    assert.ok(Array.isArray(dash.data.mentionTrend));
    assert.ok(dash.data.platforms.length >= 1);
    assert.equal(dash.data.sample, true);
    assert.equal(dash.data.live, false);
    const feed = await api("/api/posts?q=скандал&pageSize=5");
    assert.ok(feed.data.total >= 1);
    assert.equal(feed.data.items[0].sample, true);
    assert.equal(feed.data.items[0].live, false);
    const youtube = await api("/api/posts?platform=youtube&pageSize=20");
    assert.ok(youtube.data.items.every((row) => row.platform === "youtube"));
    const page = await api("/api/posts?pageSize=2&page=1&sort=engagement");
    assert.equal(page.data.items.length, 2);
    assert.ok(page.data.total > 2);
  });

  test("viewer cannot write and analyst can", async () => {
    const viewer = client();
    assert.equal((await viewer("/api/auth/login", { method: "POST", body: { email: "viewer.alpha@sample.local", password: "SampleViewer!84" } })).status, 200);
    const denied = await viewer("/api/projects", { method: "POST", body: { name: "nope" } });
    assert.equal(denied.status, 403);
    const analyst = client();
    await analyst("/api/auth/login", { method: "POST", body: { email: "analyst.alpha@sample.local", password: "SampleAnalyst!84" } });
    const created = await analyst("/api/projects", { method: "POST", body: { name: "Шинжээчийн төсөл", description: "test" } });
    assert.equal(created.status, 201);
    const keyword = await analyst(`/api/projects/${created.data.id}/keywords`, { method: "POST", body: { term: "сарнай", kind: "include" } });
    assert.equal(keyword.status, 201);
    const exclude = await analyst(`/api/projects/${created.data.id}/keywords`, { method: "POST", body: { term: "ажлын зар", kind: "exclude" } });
    assert.equal(exclude.status, 201);
    const any = await analyst(`/api/projects/${created.data.id}/conditions`, { method: "POST", body: { bucket: "any", term: "кофе" } });
    assert.equal(any.status, 201);
    const matches = await analyst(`/api/projects/${created.data.id}/matches`);
    assert.ok(matches.data.total >= 1);
    assert.ok(matches.data.items.every((row) => row.sample));
    assert.ok(!matches.data.items.some((row) => row.text.includes("ажлын зар")));
    const removed = await analyst(`/api/keywords/${keyword.data.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
  });

  test("organizations cannot read each other", async () => {
    const alpha = client();
    await alpha("/api/auth/login", { method: "POST", body: { email: "owner.alpha@sample.local", password: "SampleOwner!84" } });
    const posts = await alpha("/api/posts?pageSize=1");
    const id = posts.data.items[0].id;
    const beta = client();
    await beta("/api/auth/login", { method: "POST", body: { email: "owner.beta@sample.local", password: "SampleOther!84" } });
    const hidden = await beta(`/api/posts/${id}`);
    assert.equal(hidden.status, 404);
    const own = await beta("/api/posts?pageSize=20");
    assert.ok(own.data.items.every((row) => !row.text.toLowerCase().includes("сарнай")));
    assert.ok(own.data.items.some((row) => row.text.includes("Хөх тэнгэр")));
    const compare = await alpha("/api/competitors/compare");
    assert.ok(compare.data.competitors.some((row) => row.name === "Алтан аяга" && row.mentions >= 1));
    assert.ok(compare.data.own.share > 0 && compare.data.own.share < 1);
  });

  test("mock ingestion is labeled and official connectors stay closed", async () => {
    const api = client();
    await api("/api/auth/login", { method: "POST", body: { email: "owner.alpha@sample.local", password: "SampleOwner!84" } });
    const before = await api("/api/posts?pageSize=1");
    const official = await api("/api/ingestion/run", { method: "POST", body: { connector: "official:facebook" } });
    assert.equal(official.data.mode, "unavailable");
    assert.equal(official.data.inserted, 0);
    const afterOfficial = await api("/api/posts?pageSize=1");
    assert.equal(afterOfficial.data.total, before.data.total);
    const mock = await api("/api/ingestion/run", { method: "POST", body: { connector: "mock:instagram" } });
    assert.equal(mock.data.sample, true);
    assert.equal(mock.data.live, false);
    assert.ok(mock.data.inserted >= 1);
    const again = await api("/api/ingestion/run", { method: "POST", body: { connector: "mock:instagram" } });
    assert.equal(again.data.inserted, 0);
  });

  test("reports export pdf and excel, and the last owner stays", async () => {
    const api = client();
    await api("/api/auth/login", { method: "POST", body: { email: "owner.alpha@sample.local", password: "SampleOwner!84" } });
    const span = await api("/api/dashboard");
    const report = await api("/api/reports", { method: "POST", body: { name: "Жишээ тайлан", cadence: "weekly", from: span.data.from, to: span.data.to } });
    assert.equal(report.status, 201);
    const xlsx = await api(`/api/reports/${report.data.id}.xlsx`);
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.buf.subarray(0, 2).toString(), "PK");
    assert.ok(xlsx.buf.includes(Buffer.from("Жишээ тайлан")));
    assert.ok(xlsx.buf.includes(Buffer.from("SAMPLE DATA")));
    const pdf = await api(`/api/reports/${report.data.id}.pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.buf.subarray(0, 4).toString(), "%PDF");
    const members = await api("/api/members");
    const owner = members.data.members.find((row) => row.role === "owner");
    const demote = await api(`/api/members/${owner.id}`, { method: "PATCH", body: { role: "viewer" } });
    assert.equal(demote.status, 409);
    const trends = await api("/api/trends");
    assert.ok(trends.data.topics.some((topic) => topic.name === "Кофены чанар" && topic.current.mentions >= 1));
    const note = await api("/api/notifications");
    assert.ok(note.data.unread >= 1);
    const first = note.data.notifications.find((row) => !row.read_at);
    assert.equal((await api(`/api/notifications/${first.id}/read`, { method: "POST", body: {} })).status, 200);
  });

  test("registration isolates a new organization and reset works", async () => {
    const api = client();
    const email = `new.${Date.now()}@sample.local`;
    const created = await api("/api/auth/register", { method: "POST", body: { name: "Шинэ", email, password: "Register!84", organizationName: "Шинэ байгууллага" } });
    assert.equal(created.status, 201);
    const me = await api("/api/auth/me");
    assert.equal(me.data.user.role, "owner");
    const empty = await api("/api/posts");
    assert.equal(empty.data.total, 0);
    await api("/api/auth/logout", { method: "POST", body: {} });
    const forgot = await api("/api/auth/forgot", { method: "POST", body: { email } });
    assert.equal(forgot.data.delivered, false);
    assert.ok(forgot.data.demoResetToken);
    const reset = await api("/api/auth/reset", { method: "POST", body: { token: forgot.data.demoResetToken, password: "Changed!84" } });
    assert.equal(reset.status, 200);
    const login = await api("/api/auth/login", { method: "POST", body: { email, password: "Changed!84" } });
    assert.equal(login.status, 200);
    const score = await api("/api/sentiment/analyze", { method: "POST", body: { text: "Сэтгэл хангалуун, баярлалаа. Чанар сайхан." } });
    assert.equal(score.data.language, "mn");
    assert.equal(score.data.satisfaction, 1);
    assert.equal(score.data.liveModel, false);
  });
});
