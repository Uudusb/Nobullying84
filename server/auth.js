import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const actual = scryptSync(password, parts[1], 32);
  const expected = Buffer.from(parts[2], "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function newId() {
  return randomBytes(16).toString("hex");
}

export const COOKIE = "si_session";

export function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function sessionCookie(id, maxAge) {
  const bits = [`${COOKIE}=${encodeURIComponent(id)}`, "HttpOnly", "SameSite=Lax", "Path=/"];
  if (maxAge === 0) bits.push("Max-Age=0");
  else bits.push(`Max-Age=${maxAge}`);
  return bits.join("; ");
}
