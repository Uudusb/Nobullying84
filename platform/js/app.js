import { api } from "./api.js";
import { bars, lineChart } from "./charts.js";

const view = document.getElementById("view");
const state = { user: null, lang: localStorage.getItem("si_lang") || "mn" };

const text = {
  mn: {
    dashboard: "Самбар", monitoring: "Хяналт", keywords: "Түлхүүр үг", trends: "Тренд",
    sentiment: "Сэтгэгдэл", competitors: "Өрсөлдөгч", reports: "Тайлан", alerts: "Мэдэгдэл", team: "Баг",
    banner: "Албан холболт тохируулаагүй. «Жишээ» тэмдэгтэй мөр бол жишээ өгөгдөл, бодит урсгал биш.",
    mentions: "Дурсамж", posts: "Пост", comments: "Сэтгэгдэл", engagement: "Оролцоо", avg: "Сэтгэгдлийн дундаж",
    loading: "Ачааллаж байна…", empty: "Мөр алга.", save: "Хадгалах", search: "Хайх",
  },
  en: {
    dashboard: "Dashboard", monitoring: "Monitoring", keywords: "Keywords", trends: "Trends",
    sentiment: "Sentiment", competitors: "Competitors", reports: "Reports", alerts: "Alerts", team: "Team",
    banner: "Official connectors are not configured. Rows marked sample are sample data, not a live feed.",
    mentions: "Mentions", posts: "Posts", comments: "Comments", engagement: "Engagement", avg: "Average sentiment",
    loading: "Loading…", empty: "Nothing here.", save: "Save", search: "Search",
  },
};
const t = (key) => (text[state.lang] || text.mn)[key] || key;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch { /* ignore */ }
  return "#";
}
function loading() { view.innerHTML = `<div class="spinner" role="status"></div><p class="muted" style="text-align:center">${esc(t("loading"))}</p>`; }
function failure(error) { view.innerHTML = `<div class="error">${esc(error.message || "Error")}</div>`; }
function showError(error) {
  const box = document.getElementById("toast") || document.createElement("div");
  box.id = "toast";
  box.className = "error";
  box.textContent = error.message || "Error";
  view.prepend(box);
}
async function run(fn) {
  try {
    await fn();
  } catch (error) {
    if (error.status === 401) { location.href = "/login"; return; }
    showError(error);
  }
}
function banner() { return `<div class="banner">${esc(t("banner"))}</div>`; }
function dates() {
  const to = new Date();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 30);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

async function boot() {
  const me = await api("/api/auth/me");
  if (!me.user) { location.href = "/login"; return; }
  state.user = me.user;
  paintChrome();
  window.addEventListener("hashchange", render);
  render();
}

function paintChrome() {
  document.getElementById("orgName").textContent = state.user.organization.name;
  document.getElementById("role").textContent = state.user.role;
  document.getElementById("lang").textContent = state.lang === "mn" ? "EN" : "MN";
  const labels = text[state.lang];
  for (const link of document.querySelectorAll("[data-route]")) link.textContent = labels[link.dataset.route];
  const select = document.getElementById("orgSwitch");
  if (state.user.memberships.length > 1) {
    select.hidden = false;
    select.innerHTML = state.user.memberships.map((item) => `<option value="${esc(item.id)}" ${item.id === state.user.organization.id ? "selected" : ""}>${esc(item.name)}</option>`).join("");
  }
  api("/api/notifications").then((data) => { document.getElementById("bell").textContent = String(data.unread); }).catch(() => {});
}

document.getElementById("lang").onclick = () => {
  state.lang = state.lang === "mn" ? "en" : "mn";
  localStorage.setItem("si_lang", state.lang);
  paintChrome();
  render();
};
document.getElementById("logout").onclick = async () => {
  await api("/api/auth/logout", { method: "POST", body: {} });
  location.href = "/login";
};
document.getElementById("menu").onclick = () => document.getElementById("side").classList.toggle("open");
document.getElementById("orgSwitch").onchange = async (event) => {
  await api("/api/auth/switch", { method: "POST", body: { organizationId: event.target.value } });
  const me = await api("/api/auth/me");
  state.user = me.user;
  paintChrome();
  render();
};

function route() {
  const raw = (location.hash || "#/dashboard").replace(/^#/, "");
  const [path, query = ""] = raw.split("?");
  return { name: path.replace(/^\//, "") || "dashboard", params: new URLSearchParams(query) };
}

async function render() {
  const { name, params } = route();
  for (const link of document.querySelectorAll("[data-route]")) link.classList.toggle("active", link.dataset.route === name);
  document.getElementById("side").classList.remove("open");
  loading();
  try {
    const pages = { dashboard, monitoring, keywords, trends, sentiment, competitors, reports, alerts, team };
    await (pages[name] || dashboard)(params);
  } catch (error) {
    if (error.status === 401) { location.href = "/login"; return; }
    failure(error);
  }
}

function kpi(label, value) {
  return `<article class="card kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`;
}

async function dashboard() {
  const span = dates();
  const data = await api(`/api/dashboard?from=${span.from}&to=${span.to}`);
  view.innerHTML = `${banner()}
    <div class="kpis">
      ${kpi(t("mentions"), data.mentions)}
      ${kpi(t("posts"), data.posts)}
      ${kpi(t("comments"), data.comments)}
      ${kpi(t("engagement"), data.engagement)}
      ${kpi(t("avg"), data.sentiment.average)}
    </div>
    <div class="grid-2">
      <section class="card"><h3>${state.lang === "mn" ? "Дурсамжийн хандлага" : "Mention trend"}</h3>${lineChart(data.mentionTrend)}</section>
      <section class="card"><h3>${state.lang === "mn" ? "Сэтгэгдэл" : "Sentiment"}</h3>${bars([
        { label: "positive", value: data.sentiment.positive },
        { label: "neutral", value: data.sentiment.neutral },
        { label: "negative", value: data.sentiment.negative },
      ], "#34d399")}</section>
    </div>
    <div class="grid-2">
      <section class="card"><h3>${state.lang === "mn" ? "Платформ" : "Platforms"}</h3>${bars(data.platforms.map((row) => ({ label: row.platform, value: row.count })))}</section>
      <section class="card"><h3>${state.lang === "mn" ? "Түлхүүр үг" : "Keywords"}</h3>${bars(data.keywords.map((row) => ({ label: row.term, value: row.mentions })), "#fbbf24")}</section>
    </div>
    <div class="grid-2">
      <section class="card"><h3>${state.lang === "mn" ? "Нөлөөлөгч" : "Influencers"}</h3>${table(["name", "platform", "posts", "engagement"], data.influencers, (row) => [row.name, row.platform, row.posts, row.engagement])}</section>
      <section class="card"><h3>${state.lang === "mn" ? "Өрсөлдөгч" : "Competitors"}</h3>${bars([
        { label: "own", value: data.competitors.own.mentions },
        ...data.competitors.competitors.map((row) => ({ label: row.name, value: row.mentions })),
      ], "#fb7185")}</section>
    </div>`;
}

function table(headers, rows, map) {
  if (!rows.length) return `<div class="empty">${esc(t("empty"))}</div>`;
  return `<div style="overflow:auto"><table><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>
    ${rows.map((row) => `<tr>${map(row).map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}
  </tbody></table></div>`;
}

async function monitoring(params) {
  const span = dates();
  const query = new URLSearchParams({ from: span.from, to: span.to, pageSize: "8", sort: "date" });
  for (const key of ["q", "platform", "sentiment", "projectId", "sort", "page", "from", "to"]) {
    if (params.get(key)) query.set(key, params.get(key));
  }
  const [data, projects] = await Promise.all([api(`/api/posts?${query}`), api("/api/projects")]);
  view.innerHTML = `${banner()}
    <form class="filters" id="filters">
      <input name="q" placeholder="${esc(t("search"))}" value="${esc(query.get("q") || "")}">
      <select name="platform"><option value="">${state.lang === "mn" ? "Бүх платформ" : "All platforms"}</option>${["facebook", "x", "instagram", "threads", "youtube", "web"].map((item) => `<option value="${item}" ${query.get("platform") === item ? "selected" : ""}>${item}</option>`).join("")}</select>
      <select name="sentiment"><option value="">${state.lang === "mn" ? "Бүх сэтгэгдэл" : "All sentiment"}</option>${["positive", "neutral", "negative"].map((item) => `<option value="${item}" ${query.get("sentiment") === item ? "selected" : ""}>${item}</option>`).join("")}</select>
      <select name="projectId"><option value="">${state.lang === "mn" ? "Бүх төсөл" : "All projects"}</option>${projects.projects.map((project) => `<option value="${esc(project.id)}" ${query.get("projectId") === project.id ? "selected" : ""}>${esc(project.name)}</option>`).join("")}</select>
      <select name="sort">${["date", "date_asc", "engagement", "sentiment", "author"].map((item) => `<option ${query.get("sort") === item ? "selected" : ""}>${item}</option>`).join("")}</select>
      <input type="date" name="from" value="${esc(query.get("from"))}">
      <input type="date" name="to" value="${esc(query.get("to"))}">
      <button class="btn primary" type="submit">${esc(t("search"))}</button>
    </form>
    <section class="card">${data.items.length ? `<table><thead><tr><th>platform</th><th>author</th><th>date</th><th>text</th><th>engagement</th><th>sentiment</th></tr></thead><tbody>
      ${data.items.map((post) => `<tr class="click" data-id="${esc(post.id)}"><td>${esc(post.platform)}</td><td>${esc(post.author)}<div class="muted">@${esc(post.handle)}</div></td><td>${esc(post.postedAt.slice(0, 10))}</td><td>${esc(post.text.slice(0, 140))}</td><td>${post.engagement}</td><td><span class="badge ${esc(post.sentiment)}">${esc(post.sentiment)}</span> ${post.sample ? '<span class="badge sample">sample</span>' : ""}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty">${esc(t("empty"))}</div>`}
    <div class="pager"><button class="btn ghost" id="prev" type="button">←</button><span>${data.page} / ${Math.max(1, Math.ceil(data.total / data.pageSize))} · ${data.total}</span><button class="btn ghost" id="next" type="button">→</button></div>
    </section>`;
  document.getElementById("filters").onsubmit = (event) => {
    event.preventDefault();
    const next = new URLSearchParams(new FormData(event.target));
    next.set("page", "1");
    location.hash = `#/monitoring?${next}`;
  };
  const go = (page) => {
    query.set("page", String(page));
    location.hash = `#/monitoring?${query}`;
  };
  document.getElementById("prev").onclick = () => go(Math.max(1, data.page - 1));
  document.getElementById("next").onclick = () => go(data.page + 1);
  for (const row of view.querySelectorAll("[data-id]")) row.onclick = () => openPost(row.dataset.id);
}

async function openPost(id) {
  const data = await api(`/api/posts/${id}`);
  const box = document.createElement("div");
  box.className = "modal";
  box.innerHTML = `<div class="box"><button class="btn ghost" id="close" type="button">✕</button>
    <p><span class="badge sample">${data.post.sample ? "sample data" : "not sample"}</span> <span class="badge ${esc(data.post.sentiment)}">${esc(data.post.sentiment)}</span></p>
    <h3>${esc(data.post.author)} · ${esc(data.post.platform)}</h3>
    <p>${esc(data.post.text)}</p>
    <p class="muted">${esc(data.post.postedAt)} · <a href="${safeUrl(data.post.url)}" target="_blank" rel="noopener">${esc(data.post.url)}</a></p>
    <p>${state.lang === "mn" ? "Оролцоо" : "Engagement"}: ${data.post.engagement}</p>
    <h4>${state.lang === "mn" ? "Сэтгэгдлүүд" : "Comments"}</h4>
    ${data.comments.map((comment) => `<p>${esc(comment.author)}: ${esc(comment.text)} <span class="badge ${esc(comment.sentiment)}">${esc(comment.sentiment)}</span> ${comment.sample ? '<span class="badge sample">sample</span>' : ""}</p>`).join("") || `<p class="muted">${esc(t("empty"))}</p>`}
  </div>`;
  document.body.appendChild(box);
  box.querySelector("#close").onclick = () => box.remove();
  box.onclick = (event) => { if (event.target === box) box.remove(); };
}

async function keywords() {
  const data = await api("/api/projects");
  view.innerHTML = `${banner()}
    <form class="card stack" id="create">
      <h3>${state.lang === "mn" ? "Шинэ төсөл" : "New project"}</h3>
      <input name="name" placeholder="${state.lang === "mn" ? "Нэр" : "Name"}" required>
      <textarea name="description" placeholder="${state.lang === "mn" ? "Тайлбар" : "Description"}"></textarea>
      <button class="btn primary" type="submit">${esc(t("save"))}</button>
    </form>
    ${data.projects.map((project) => `<section class="card" data-project="${esc(project.id)}">
      <h3>${esc(project.name)}</h3><p class="muted">${esc(project.description)}</p>
      <p>${project.keywords.map((keyword) => `<span class="badge ${keyword.kind === "exclude" ? "negative" : "positive"}">${esc(keyword.kind)}: ${esc(keyword.term)}</span>`).join(" ")}
      ${project.conditions.map((condition) => `<span class="badge neutral">${esc(condition.bucket)}: ${esc(condition.term)}</span>`).join(" ")}</p>
      <form class="filters term"><input name="term" required placeholder="term"><select name="kind"><option>include</option><option>exclude</option></select><button class="btn primary">+</button></form>
      <form class="filters cond"><select name="bucket"><option>all</option><option>any</option><option>not</option></select><input name="term" required placeholder="boolean"><button class="btn primary">+</button></form>
      <form class="filters preview"><input type="date" name="from" value="${dates().from}"><input type="date" name="to" value="${dates().to}"><select name="platform"><option value="">all</option><option>facebook</option><option>x</option><option>instagram</option><option>threads</option><option>youtube</option><option>web</option></select><button class="btn ghost">${state.lang === "mn" ? "Тааруулах" : "Preview"}</button></form>
      <div class="preview-out"></div>
      <button class="btn ghost del" type="button">${state.lang === "mn" ? "Устгах" : "Delete"}</button>
    </section>`).join("") || `<div class="empty">${esc(t("empty"))}</div>`}`;
  document.getElementById("create").onsubmit = (event) => run(async () => {
    event.preventDefault();
    await api("/api/projects", { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
    render();
  });
  for (const section of view.querySelectorAll("[data-project]")) {
    const id = section.dataset.project;
    section.querySelector(".term").onsubmit = (event) => run(async () => {
      event.preventDefault();
      await api(`/api/projects/${id}/keywords`, { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
      render();
    });
    section.querySelector(".cond").onsubmit = (event) => run(async () => {
      event.preventDefault();
      await api(`/api/projects/${id}/conditions`, { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
      render();
    });
    section.querySelector(".preview").onsubmit = async (event) => {
      event.preventDefault();
      const query = new URLSearchParams(new FormData(event.target));
      const match = await api(`/api/projects/${id}/matches?${query}`);
      section.querySelector(".preview-out").innerHTML = `<p class="muted">${match.total} ${state.lang === "mn" ? "таарсан жишээ пост" : "matching sample posts"}</p>`;
    };
    section.querySelector(".del").onclick = () => run(async () => {
      await api(`/api/projects/${id}`, { method: "DELETE" });
      render();
    });
  }
}

async function trends(params) {
  const span = dates();
  const query = new URLSearchParams({ from: params.get("from") || span.from, to: params.get("to") || span.to });
  const data = await api(`/api/trends?${query}`);
  view.innerHTML = `${banner()}
    <form class="filters" id="range"><input type="date" name="from" value="${esc(query.get("from"))}"><input type="date" name="to" value="${esc(query.get("to"))}"><button class="btn primary">${esc(t("search"))}</button></form>
    <form class="filters" id="add"><input name="name" placeholder="${state.lang === "mn" ? "Шинэ сэдэв" : "New topic"}" required><button class="btn primary">${esc(t("save"))}</button></form>
    ${data.topics.map((topic) => `<section class="card"><h3>${esc(topic.name)}</h3>
      <div class="kpis">
        ${kpi(state.lang === "mn" ? "Одоо" : "Now", topic.current.mentions)}
        ${kpi(state.lang === "mn" ? "Өмнөх" : "Previous", topic.previous.mentions)}
        ${kpi(t("engagement"), topic.current.engagement)}
        ${kpi(t("sentiment"), topic.current.sentiment)}
      </div>
      ${bars(Object.entries(topic.current.platforms).map(([label, value]) => ({ label, value })))}
    </section>`).join("") || `<div class="empty">${esc(t("empty"))}</div>`}`;
  document.getElementById("range").onsubmit = (event) => {
    event.preventDefault();
    location.hash = `#/trends?${new URLSearchParams(new FormData(event.target))}`;
  };
  document.getElementById("add").onsubmit = (event) => run(async () => {
    event.preventDefault();
    await api("/api/topics", { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
    render();
  });
}

async function sentiment() {
  const span = dates();
  const data = await api(`/api/sentiment?from=${span.from}&to=${span.to}`);
  view.innerHTML = `${banner()}<p class="muted">${esc(data.engine)} · live model: ${data.liveModel}</p>
    <div class="kpis">
      ${kpi("positive", data.summary.positive)}${kpi("negative", data.summary.negative)}${kpi("neutral", data.summary.neutral)}
      ${kpi("mn", data.summary.mn)}${kpi("en", data.summary.en)}
    </div>
    <div class="kpis">
      ${kpi(state.lang === "mn" ? "Гомдол" : "Complaints", data.summary.complaint)}
      ${kpi(state.lang === "mn" ? "Ханамж" : "Satisfaction", data.summary.satisfaction)}
      ${kpi(state.lang === "mn" ? "Бүтээгдэхүүн" : "Product", data.summary.product_feedback)}
      ${kpi(state.lang === "mn" ? "Брэнд" : "Brand", data.summary.brand_perception)}
    </div>
    <section class="card"><h3>${state.lang === "mn" ? "Эрсдэл" : "Crisis signals"}</h3>
      ${data.crises.map((post) => `<p><span class="badge sample">sample</span> ${esc(post.text)}</p>`).join("") || `<div class="empty">${esc(t("empty"))}</div>`}
    </section>
    <form class="card stack" id="analyze">
      <h3>${state.lang === "mn" ? "Шинэ текст шалгах" : "Score a text"}</h3>
      <textarea name="text" required placeholder="Сарнай кофены үйлчилгээ муу. / The roast is excellent."></textarea>
      <button class="btn primary">${state.lang === "mn" ? "Оноох" : "Analyze"}</button>
      <p id="result"></p>
    </form>`;
  document.getElementById("analyze").onsubmit = (event) => run(async () => {
    event.preventDefault();
    const result = await api("/api/sentiment/analyze", { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
    document.getElementById("result").textContent = `${result.summary} · score ${result.score} · crisis ${result.crisis_risk}`;
  });
}

async function competitors() {
  const span = dates();
  const [list, compare] = await Promise.all([
    api("/api/competitors"),
    api(`/api/competitors/compare?from=${span.from}&to=${span.to}`),
  ]);
  view.innerHTML = `${banner()}
    <section class="card"><h3>Share of voice</h3>${bars([
      { label: compare.own.name, value: Math.round(compare.own.share * 100) },
      ...compare.competitors.map((row) => ({ label: row.name, value: Math.round(row.share * 100) })),
    ])}<p class="muted">${state.lang === "mn" ? "Хувь нь хянаж буй багцын нийлбэрээс. Жишээ өгөгдөл." : "Share of the tracked set. Sample data."}</p></section>
    <section class="card">${table(["name", "mentions", "engagement", "sentiment"], compare.competitors, (row) => [esc(row.name), row.mentions, row.engagement, row.sentiment])}</section>
    <form class="card filters" id="add"><input name="name" required placeholder="${state.lang === "mn" ? "Өрсөлдөгчийн нэр" : "Competitor"}"><button class="btn primary">${esc(t("save"))}</button></form>
    ${list.competitors.map((row) => `<section class="card"><h3>${esc(row.name)}</h3><p>${row.terms.map((term) => `<span class="badge neutral">${esc(term.term)}</span>`).join(" ")}</p>
      <form class="filters term"><input name="term" required><button class="btn primary">+</button></form></section>`).join("")}
    <section class="card"><h3>${state.lang === "mn" ? "Сэдвийн харьцуулалт" : "Topic overlap"}</h3>
      ${compare.topicOverlap.map((topic) => `<p><strong>${esc(topic.topic)}</strong> ${topic.shares.map((share) => `${esc(share.name)}: ${share.mentions}`).join(" · ")}</p>`).join("")}
    </section>`;
  document.getElementById("add").onsubmit = (event) => run(async () => {
    event.preventDefault();
    await api("/api/competitors", { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
    render();
  });
  list.competitors.forEach((row, index) => {
    view.querySelectorAll(".term")[index].onsubmit = (event) => run(async () => {
      event.preventDefault();
      await api(`/api/competitors/${row.id}/terms`, { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
      render();
    });
  });
}

async function reports() {
  const span = dates();
  const data = await api("/api/reports");
  const connectors = await api("/api/connectors");
  view.innerHTML = `${banner()}
    <section class="card"><h3>${state.lang === "mn" ? "Жишээ таталт" : "Sample ingestion"}</h3>
      <div class="filters">${connectors.connectors.filter((item) => item.mode === "mock").map((item) => `<button class="btn ghost run" data-id="${esc(item.id)}" type="button">${esc(item.platform)}</button>`).join("")}</div>
      <p class="muted">${connectors.connectors.filter((item) => item.mode === "official").map((item) => `${esc(item.platform)}: ${esc(item.reason)}`).join(" · ")}</p>
      <p id="runOut"></p>
    </section>
    <form class="card filters" id="create">
      <input name="name" required placeholder="${state.lang === "mn" ? "Тайлангийн нэр" : "Report name"}">
      <select name="cadence"><option>daily</option><option>weekly</option><option>monthly</option></select>
      <input type="date" name="from" value="${span.from}" required>
      <input type="date" name="to" value="${span.to}" required>
      <button class="btn primary">${esc(t("save"))}</button>
    </form>
    <section class="card">${data.reports.map((report) => `<p>${esc(report.name)} · ${esc(report.cadence)} · ${esc(report.date_from)} – ${esc(report.date_to)}
      <a href="/api/reports/${esc(report.id)}.pdf">PDF</a> · <a href="/api/reports/${esc(report.id)}.xlsx">Excel</a></p>`).join("") || `<div class="empty">${esc(t("empty"))}</div>`}</section>`;
  for (const button of view.querySelectorAll(".run")) {
    button.onclick = async () => {
      button.disabled = true;
      try {
        const result = await api("/api/ingestion/run", { method: "POST", body: { connector: button.dataset.id } });
        document.getElementById("runOut").textContent = `${result.message} +${result.inserted}`;
      } catch (error) {
        document.getElementById("runOut").textContent = error.message;
      }
      button.disabled = false;
    };
  }
  document.getElementById("create").onsubmit = (event) => run(async () => {
    event.preventDefault();
    await api("/api/reports", { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
    render();
  });
}

async function alerts() {
  const data = await api("/api/notifications");
  view.innerHTML = `${banner()}${data.notifications.map((note) => `<article class="card"><strong>${esc(note.title)}</strong><p>${esc(note.body)}</p><p class="muted">${esc(note.created_at)} ${note.read_at ? "· read" : ""}</p>${note.read_at ? "" : `<button class="btn ghost read" data-id="${esc(note.id)}" type="button">${state.lang === "mn" ? "Уншсан" : "Mark read"}</button>`}</article>`).join("") || `<div class="empty">${esc(t("empty"))}</div>`}`;
  for (const button of view.querySelectorAll(".read")) {
    button.onclick = async () => {
      await api(`/api/notifications/${button.dataset.id}/read`, { method: "POST", body: {} });
      render();
      paintChrome();
    };
  }
}

async function team() {
  const members = await api("/api/members");
  let logs = { logs: [] };
  try { logs = await api("/api/audit"); } catch (error) { logs = { error: error.message }; }
  view.innerHTML = `${banner()}
    <section class="card">${table(["name", "email", "role"], members.members, (row) => [esc(row.name), esc(row.email), esc(row.role)])}</section>
    <form class="card stack" id="add">
      <h3>${state.lang === "mn" ? "Гишүүн нэмэх" : "Add member"}</h3>
      <input name="name" placeholder="${state.lang === "mn" ? "Нэр" : "Name"}">
      <input name="email" type="email" required>
      <input name="password" type="text" placeholder="${state.lang === "mn" ? "Нууц үг (шинэ бол)" : "Password if new"}">
      <select name="role"><option>viewer</option><option>analyst</option><option>admin</option><option>owner</option></select>
      <button class="btn primary">${esc(t("save"))}</button>
      <p id="memberErr" class="error" hidden></p>
    </form>
    <section class="card"><h3>${state.lang === "mn" ? "Аудит" : "Audit"}</h3>
      ${logs.error ? `<div class="error">${esc(logs.error)}</div>` : table(["created_at", "action", "entity", "detail"], logs.logs, (row) => [esc(row.created_at), esc(row.action), esc(row.entity), esc(row.detail)])}
    </section>`;
  document.getElementById("add").onsubmit = async (event) => {
    event.preventDefault();
    const err = document.getElementById("memberErr");
    err.hidden = true;
    try {
      await api("/api/members", { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
      render();
    } catch (error) {
      err.hidden = false;
      err.textContent = error.message;
    }
  };
}

boot().catch((error) => failure(error));
