const copy = {
  mn: {
    navTrends: "Тренд", navSources: "Эх сурвалж", navFaq: "Асуулт", navContact: "Холбоо", signIn: "Нэвтрэх",
    contact: "Холбоо барих", trends: "Тренд сэдэв", trendTitle: "Тренд сэдэв", sourceTitle: "Эх сурвалж",
    faqTitle: "Нийтлэг асуулт", contactTitle: "Холбоо барих",
    heroTitle: "Сошиал мэдээллээ нэг самбараас",
    heroText: "Байгууллагынхаа дурсамж, гомдол, сэтгэл ханамжийг Монгол, Англи хэл дээр нь ажиглаарай. Энэ хуудас олон нийтийн загварт тулгуурласан бие даасан демо бөгөөд sumbee.mn-тэй холбоогүй.",
  },
  en: {
    navTrends: "Trends", navSources: "Sources", navFaq: "FAQ", navContact: "Contact", signIn: "Sign in",
    contact: "Contact", trends: "Trend topics", trendTitle: "Trend topics", sourceTitle: "Sources",
    faqTitle: "Common questions", contactTitle: "Contact",
    heroTitle: "One board for the public conversation",
    heroText: "Watch mentions, complaints, and satisfaction in Mongolian and English. This is an independent demo based on a public layout. It is not sumbee.mn.",
  },
};

const topics = [
  ["Сарнай кофе", "Сүүлийн 14 хоног", "Жишээ"],
  ["Алтан аяга", "Сүүлийн 14 хоног", "Жишээ"],
  ["Номин талх", "Сүүлийн 14 хоног", "Жишээ"],
];
document.getElementById("topics").innerHTML = topics.map(([name, range, price], i) => `
  <button class="topic" type="button" data-gate>
    <div class="cover" style="background:linear-gradient(135deg, hsl(${i * 48 + 200} 70% 42%), #020617)"><span class="chip">${price}</span></div>
    <div class="body"><h3>${name}</h3><div class="muted">${range}</div>
      <div class="stats"><span>f sample</span><span>ig sample</span><span>x sample</span><span>yt sample</span></div>
    </div>
  </button>`).join("");

const sources = [["Facebook", "жишээ"], ["X", "жишээ"], ["Instagram", "жишээ"], ["Threads", "жишээ"], ["Web", "жишээ"], ["YouTube", "жишээ"], ["Хаяг", "жишээ"], ["Пост", "жишээ"]];
document.getElementById("sourcesGrid").innerHTML = sources.map(([name]) => `<article><strong>—</strong><span>${name}</span><div class="muted">sample</div></article>`).join("");

function apply(lang) {
  const table = copy[lang] || copy.mn;
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll("[data-i]")) el.textContent = table[el.dataset.i] || el.textContent;
  document.getElementById("heroTitle").textContent = table.heroTitle;
  document.getElementById("heroText").textContent = table.heroText;
  localStorage.setItem("si_lang", lang);
}
apply(localStorage.getItem("si_lang") || "mn");
for (const button of document.querySelectorAll("[data-lang]")) button.onclick = () => apply(button.dataset.lang);
document.getElementById("theme").onclick = () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
};
document.getElementById("menu").onclick = () => document.getElementById("nav").classList.toggle("open");
const gate = document.getElementById("gate");
for (const button of document.querySelectorAll("[data-gate]")) button.onclick = () => { gate.hidden = false; };
document.getElementById("closeGate").onclick = () => { gate.hidden = true; };

document.getElementById("contactForm").onsubmit = async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const res = await fetch("/api/contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const json = await res.json();
  document.getElementById("contactOut").textContent = json.message;
  event.target.reset();
};
document.getElementById("openChat").onclick = () => {
  const panel = document.getElementById("chat");
  panel.hidden = !panel.hidden;
};
document.getElementById("chatForm").onsubmit = async (event) => {
  event.preventDefault();
  const q = new FormData(event.target).get("q");
  const res = await fetch(`/api/help?q=${encodeURIComponent(q)}`);
  const json = await res.json();
  document.getElementById("chatLog").textContent = json.reply;
};
