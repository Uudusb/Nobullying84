const PLATFORMS = ["facebook", "x", "instagram", "threads", "youtube", "web"];

const SAMPLE_COPY = {
  facebook: [
    { author: "Номин", handle: "nomin.sample", text: "Сарнай кофены үйлчилгээ муу, удаан. Гомдол гаргана.", likes: 12, comments: 4, shares: 1 },
    { author: "Болд", handle: "bold.sample", text: "Сарнай кофе үнэхээр гоё. Баярлалаа, чанар сайхан.", likes: 80, comments: 9, shares: 4 },
  ],
  x: [
    { author: "Sara", handle: "sara.sample", text: "Алтан аяга scandal and boycott. Terrible service and public outrage.", likes: 40, comments: 11, shares: 8 },
    { author: "Tuvshuu", handle: "tuvshuu.sample", text: "Номин талхны амт сайхан, дахин авна. Сэтгэл хангалуун.", likes: 22, comments: 2, shares: 0 },
  ],
  instagram: [
    { author: "Anu", handle: "anu.sample", text: "The new roast is excellent and I love the quality.", likes: 140, comments: 18, shares: 6 },
  ],
  threads: [
    { author: "Erdene", handle: "erdene.sample", text: "Дахиж авахгүй. Чанаргүй бүтээгдэхүүн, үнэ өндөр.", likes: 15, comments: 3, shares: 1 },
  ],
  youtube: [
    { author: "Studio", handle: "studio.sample", text: "Product review: quality is reliable and the brand trust is high.", likes: 90, comments: 20, shares: 5 },
  ],
  web: [
    { author: "News Desk", handle: "news.sample", text: "Сарнай брэнд нэр хүнд сайн. Хэрэглэгчид итгэлтэй байна.", likes: 10, comments: 1, shares: 2 },
  ],
};

export function listConnectors() {
  const rows = [];
  for (const platform of PLATFORMS) {
    const env = process.env[`SI_CONNECTOR_${platform.toUpperCase()}`];
    rows.push({
      id: `official:${platform}`,
      platform,
      mode: "official",
      available: Boolean(env),
      live: false,
      reason: env ? "Credential is set but this build does not call external APIs." : "Official API credentials are not configured.",
    });
    rows.push({
      id: `mock:${platform}`,
      platform,
      mode: "mock",
      available: true,
      live: false,
      reason: "Sample connector. Every row is sample data.",
    });
  }
  return rows;
}

export function runConnector(id) {
  const [mode, platform] = String(id || "").split(":");
  if (!PLATFORMS.includes(platform)) {
    return { error: "Unknown connector.", status: 400 };
  }
  if (mode === "official") {
    return {
      mode: "unavailable",
      sample: false,
      live: false,
      platform,
      items: [],
      message: "Official API credentials are not configured. No request was sent.",
    };
  }
  if (mode !== "mock") return { error: "Unknown connector.", status: 400 };
  const now = Date.now();
  const items = (SAMPLE_COPY[platform] || []).map((row, index) => ({
    platform,
    externalId: `mock-${platform}-${index + 1}`,
    authorName: row.author,
    authorHandle: row.handle,
    postedAt: new Date(now - (index + 1) * 3600 * 1000).toISOString(),
    url: `https://example.local/sample/${platform}/${index + 1}`,
    text: row.text,
    likes: row.likes,
    commentsCount: row.comments,
    shares: row.shares,
    sample: true,
    source: "mock",
    comments: index === 0 ? [{
      authorName: "Sample reader",
      text: platform === "instagram"
        ? "I love this too."
        : "Үйлчилгээ муу гэсэн гомдол дэмжиж байна.",
      postedAt: new Date(now - index * 3600 * 1000).toISOString(),
      sample: true,
    }] : [],
  }));
  return {
    mode: "mock",
    sample: true,
    live: false,
    platform,
    items,
    message: "Sample connector finished. Rows are sample data, not live posts.",
  };
}
