const POS_MN = ["сайхан", "гоё", "баярлалаа", "баяртай", "дуртай", "чанартай", "магтай", "амжилт", "хангалуун", "найдвартай", "таалагд", "шилдэг", "гаяг"];
const NEG_MN = ["муу", "гомдол", "уур", "чанаргүй", "буцаалт", "залилан", "худлаа", "дундуур", "асуудал", "болохгүй", "удаан", "харамс", "дахиж", "скандал", "бойкот", "дургүйц"];
const POS_EN = ["excellent", "love", "great", "good", "amazing", "happy", "quality", "reliable", "wonderful", "best", "thank", "satisfied", "pleasant"];
const NEG_EN = ["terrible", "awful", "bad", "hate", "poor", "refund", "broken", "worst", "slow", "angry", "complaint", "scandal", "boycott", "horrible", "disappointed"];

const COMPLAINT_MN = ["гомдол", "үйлчилгээ муу", "буцааж", "солиул"];
const COMPLAINT_EN = ["complaint", "refund", "poor service", "speak to a manager"];
const SAT_MN = ["сэтгэл хангалуун", "сэтгэл ханамж", "дахин авна", "баярлалаа"];
const SAT_EN = ["satisfied", "will buy again", "thank you", "love"];
const PRODUCT_MN = ["бүтээгдэхүүн", "бараа", "чанар", "үнэ", "амт"];
const PRODUCT_EN = ["product", "quality", "price", "roast", "item"];
const BRAND_MN = ["брэнд", "нэр хүнд", "итгэл"];
const BRAND_EN = ["brand", "reputation", "trust"];
const CRISIS_MN = ["скандал", "бойкот", "дургүйцэл", "худал мэдээ", "осголдол", "хордлого"];
const CRISIS_EN = ["scandal", "boycott", "outrage", "fake news", "poison", "crisis"];

const NEGATORS_EN = new Set(["not", "no", "never", "n't"]);

function tokensOf(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function languageOf(text) {
  return /[\u0400-\u04FF]/.test(text) ? "mn" : "en";
}

function hit(token, stems, flip) {
  const ok = stems.some((stem) => token === stem || token.startsWith(stem));
  return ok ? (flip ? -1 : 1) : 0;
}

function phrase(text, list) {
  const hay = text.toLowerCase();
  return list.some((item) => hay.includes(item));
}

export function analyze(text) {
  const raw = String(text || "").trim();
  const language = languageOf(raw);
  const tokens = tokensOf(raw);
  const posStems = language === "mn" ? POS_MN : POS_EN;
  const negStems = language === "mn" ? NEG_MN : NEG_EN;
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const flipEn = language === "en" && i > 0 && NEGATORS_EN.has(tokens[i - 1]);
    const flipMn = language === "mn" && tokens[i + 1] === "биш";
    const flip = flipEn || flipMn;
    const p = hit(token, posStems, flip);
    const n = hit(token, negStems, flip);
    if (p > 0) pos += 1;
    if (p < 0) neg += 1;
    if (n > 0) neg += 1;
    if (n < 0) pos += 1;
  }
  const score = Math.max(-1, Math.min(1, (pos - neg) / (pos + neg + 1)));
  const label = score > 0.15 ? "positive" : score < -0.15 ? "negative" : "neutral";
  const complaint = phrase(raw, language === "mn" ? COMPLAINT_MN : COMPLAINT_EN) ? 1 : 0;
  const satisfaction = phrase(raw, language === "mn" ? SAT_MN : SAT_EN) ? 1 : 0;
  const product = phrase(raw, language === "mn" ? PRODUCT_MN : PRODUCT_EN) ? 1 : 0;
  const brand = phrase(raw, language === "mn" ? BRAND_MN : BRAND_EN) ? 1 : 0;
  const crisisPhrase = phrase(raw, language === "mn" ? CRISIS_MN : CRISIS_EN);
  let crisis = 0;
  if (crisisPhrase) crisis += 0.75;
  if (crisisPhrase && label === "negative") crisis += 0.25;
  crisis = Math.min(1, crisis);
  const bits = [language, label];
  if (complaint) bits.push(language === "mn" ? "гомдол" : "complaint");
  if (satisfaction) bits.push(language === "mn" ? "ханамж" : "satisfaction");
  if (product) bits.push(language === "mn" ? "бүтээгдэхүүн" : "product");
  if (brand) bits.push(language === "mn" ? "брэнд" : "brand");
  if (crisis >= 0.5) bits.push(language === "mn" ? "эвдрэл" : "crisis");
  return {
    language,
    label,
    score: Number(score.toFixed(4)),
    complaint,
    satisfaction,
    product_feedback: product,
    brand_perception: brand,
    crisis_risk: Number(crisis.toFixed(4)),
    summary: bits.join(" · "),
  };
}
