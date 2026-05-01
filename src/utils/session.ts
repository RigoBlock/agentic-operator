/**
 * HMAC-based session tokens for browser origin verification.
 *
 * The Worker mints a short-lived token when the browser calls GET /api/session.
 * This token is included in all subsequent API requests as X-Rigoblock-Session.
 * Because only the Worker knows SESSION_SECRET, external agents cannot forge it.
 *
 * An agent CAN call GET /api/session to obtain a token, but that endpoint is
 * IP-rate-limited (20/hour), making automated abuse expensive to scale.
 *
 * Token format: {timestamp_b36}.{nonce_hex}.{hmac_hex}
 */

export const SESSION_HEADER = "x-rigoblock-session";

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
    if (isNaN(tsMs) || Date.now() - tsMs > EXPIRY_MS) return false;
    const { verify: key } = await getKeys(secret);
    const sigBytes = new Uint8Array(sigHex.match(/../g)!.map((h) => parseInt(h, 16)));
    return await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(payload));
  } catch {
    return false;
  }
}
