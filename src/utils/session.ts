/**
 * HMAC-based session tokens and cookies for browser origin verification.
 *
 * Token format: {timestamp_b36}.{nonce_hex}.{hmac_hex}
 *
 * Cookies (HttpOnly, SameSite=Strict) replace the old header-based session
 * tokens. Because the cookie is set by the server when serving HTML and is
 * SameSite=Strict, cross-site attackers cannot obtain or forge it.
 */

export const SESSION_HEADER = "x-rigoblock-session";
export const APP_COOKIE_NAME = "__rgapp";

const EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// Cache derived CryptoKeys keyed by secret to avoid re-deriving on every request.
// Cloudflare Worker isolates are long-lived and module-level state persists across
// requests within the same isolate, so this cache is safe and effective.
const keyCache = new Map<string, { sign: CryptoKey; verify: CryptoKey }>();

async function getKeys(secret: string): Promise<{ sign: CryptoKey; verify: CryptoKey }> {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  const raw = new TextEncoder().encode(secret);
  const [sign, verify] = await Promise.all([
    crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]),
  ]);
  const keys = { sign, verify };
  keyCache.set(secret, keys);
  return keys;
}

const encoder = new TextEncoder();

export async function generateSessionToken(secret: string): Promise<string> {
  const ts = Date.now().toString(36);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const payload = `${ts}.${nonce}`;
  const { sign: key } = await getKeys(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${payload}.${hex}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<boolean> {
  try {
    const lastDot = token.lastIndexOf(".");
    if (lastDot < 0) return false;
    const payload = token.slice(0, lastDot);
    const sigHex = token.slice(lastDot + 1);
    const firstDot = payload.indexOf(".");
    if (firstDot < 0) return false;
    const tsMs = parseInt(payload.slice(0, firstDot), 36);
    if (isNaN(tsMs) || tsMs > Date.now() + 60_000 || Date.now() - tsMs > EXPIRY_MS) return false;
    const { verify: key } = await getKeys(secret);
    const sigBytes = new Uint8Array(sigHex.match(/../g)!.map((h) => parseInt(h, 16)));
    return await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(payload));
  } catch {
    return false;
  }
}

/** Generate a Set-Cookie header value for the frontend app cookie. */
export async function generateAppCookie(secret: string): Promise<string> {
  const token = await generateSessionToken(secret);
  return `${APP_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`;
}

/** Verify the app cookie from a Cookie header string. */
export async function verifyAppCookie(cookieHeader: string | null, secret: string): Promise<boolean> {
  if (!cookieHeader) return false;
  const match = cookieHeader.match(new RegExp(`${APP_COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  return verifySessionToken(match[1], secret);
}
