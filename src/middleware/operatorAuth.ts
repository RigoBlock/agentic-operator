/**
 * Operator Authentication Middleware — auth ONLY, no payment effects.
 *
 * Establishes the verified operator identity for a request:
 *   1. Opaque session token (rb_session HttpOnly cookie or X-Session-Token
 *      header) minted by an earlier signature redemption.
 *   2. EIP-191 operator signature headers (frontend's first request): verified
 *      and REDEEMED once for a session token (single-use; a captured signature
 *      is worthless after redemption). Rate-limited per address.
 *
 * The minted session is an AUTH credential — it is never an x402 exemption.
 * Every protected route requires x402 payment regardless of auth state
 * (the first-party UI pays via public/frontend/x402.js like any caller).
 * Telegram bot traffic never passes through either middleware: it calls
 * processChat in-worker and uses public /api/telegram/* routes.
 *
 * Without KV (dev/test), signature verification remains but is replayable
 * and no session is minted.
 */

import type { MiddlewareHandler, Context } from "hono";
import type { Env, AppVariables } from "../types.js";
import {
  verifyOperatorSignatureOnly,
  computeNetworkHash,
  verifySessionToken,
  redeemSignatureForSession,
  mintSessionToken,
} from "../services/auth.js";

/** Cookie that carries the opaque session token (HttpOnly — JS/XSS cannot read it). */
export const SESSION_COOKIE = "rb_session";
const SESSION_TTL_SEC = 24 * 60 * 60;

// ── Rate limiting (signature redemptions only — the one un-paid path) ──

const RATE_LIMIT_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WARNING_THRESHOLD = 10;

interface RateLimitState {
  count: number;
  windowStart: number;
}

async function checkRateLimit(
  kv: KVNamespace | undefined,
  operatorAddress: string,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  if (!kv) {
    return { allowed: true, remaining: RATE_LIMIT_MAX, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS };
  }
  const key = `rate-limit:${operatorAddress.toLowerCase()}`;
  const now = Date.now();
  const data = await kv.get<RateLimitState>(key, "json");

  if (!data || now - data.windowStart > RATE_LIMIT_WINDOW_MS) {
    const state: RateLimitState = { count: 1, windowStart: now };
    await kv.put(key, JSON.stringify(state), {
      expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) + 60,
    });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }

  if (data.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetAt: data.windowStart + RATE_LIMIT_WINDOW_MS };
  }

  const state: RateLimitState = { count: data.count + 1, windowStart: data.windowStart };
  await kv.put(key, JSON.stringify(state), {
    expirationTtl: Math.ceil((data.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000) + 60,
  });
  return { allowed: true, remaining: RATE_LIMIT_MAX - data.count - 1, resetAt: data.windowStart + RATE_LIMIT_WINDOW_MS };
}

function setRateLimitHeaders(
  c: { header: (k: string, v: string) => void },
  remaining: number,
  resetAt: number,
): void {
  c.header("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
  c.header("X-RateLimit-Remaining", String(remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
  if (remaining < RATE_LIMIT_WARNING_THRESHOLD) {
    const resetIso = new Date(resetAt).toISOString();
    c.header("X-RateLimit-Warning", `${remaining} requests remaining before rate limit. Resets at ${resetIso}`);
  }
}

/**
 * Session binding context: salted hash of the caller's device ID and
 * User-Agent (deliberately NOT the egress IP — it rotates between connections
 * on IPv6 privacy extensions / dual-stack clients and made IP-bound sessions
 * fail every other request). Clients without the X-Device-Id header (curl,
 * outdated frontends) bind to the UA alone. Only a hash is ever stored.
 */
function requestNetworkHash(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
): string {
  const raw = c.req.header("x-device-id") || "";
  const deviceId = /^0x[0-9a-fA-F]{32}$/.test(raw) ? raw.toLowerCase() : "";
  const ua = c.req.header("user-agent") || "";
  return computeNetworkHash(deviceId, ua);
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function createOperatorAuthMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  return async (c, next) => {
    if (!c.env.KV) {
      // Dev/test legacy: signature auth is replayable, no sessions.
      const operatorAddress = c.req.header("x-operator-address");
      const authSignature = c.req.header("x-auth-signature");
      const authTimestamp = c.req.header("x-auth-timestamp");
      if (operatorAddress && authSignature && authTimestamp) {
        const ts = Number(authTimestamp);
        if (!isNaN(ts)) {
          let valid = false;
          try {
            valid = await verifyOperatorSignatureOnly(operatorAddress, authSignature, ts);
          } catch {
            // signature verification threw — treat as invalid
          }
          if (valid) {
            c.set("operatorAuthVerified", true);
            c.set("operatorAuth", { address: operatorAddress, signature: authSignature, timestamp: ts });
          } else {
            return c.json(
              { error: "Authentication expired", detail: "Your session signature is invalid or expired. Please re-authenticate." },
              401,
            );
          }
        }
      }
      await next();
      return;
    }

    // ── 1. Existing session (cookie or header) — authenticates ANY route ──
    const cookieToken = parseCookieHeader(c.req.header("cookie"))[SESSION_COOKIE];
    const headerToken = c.req.header("x-session-token");
    const sessionToken = cookieToken || headerToken;
    if (sessionToken) {
      const netHash = requestNetworkHash(c);
      const sess = await verifySessionToken(c.env.KV, sessionToken, netHash);
      if (sess) {
        c.set("operatorAuthVerified", true);
        c.set("operatorAuth", { address: sess.address, signature: "", timestamp: 0, viaSession: true });
      } else if (headerToken) {
        // Explicitly presented token is invalid/expired/foreign — 401 so the
        // frontend re-signs instead of silently degrading. (A stale cookie
        // degrades to anonymous: the browser can't react to it.)
        return c.json(
          {
            error: "Session expired",
            detail: "Your session is invalid, expired, or was created on a different network. Please sign again to authenticate.",
          },
          401,
        );
      }
      await next();
      return;
    }

    // ── 2. Signature redemption — mints the session, rate-limited ──
    const operatorAddress = c.req.header("x-operator-address");
    const authSignature = c.req.header("x-auth-signature");
    const authTimestamp = c.req.header("x-auth-timestamp");

    if (operatorAddress && authSignature && authTimestamp) {
      const ts = Number(authTimestamp);
      if (!isNaN(ts)) {
        let valid = false;
        try {
          valid = await verifyOperatorSignatureOnly(operatorAddress, authSignature, ts);
        } catch {
          // signature verification threw — treat as invalid
        }

        if (!valid) {
          // Auth headers were sent but signature is invalid or expired —
          // 401 so the frontend re-authenticates.
          return c.json(
            { error: "Authentication expired", detail: "Your session signature is invalid or expired. Please re-authenticate." },
            401,
          );
        }

        const rateLimit = await checkRateLimit(c.env.KV, operatorAddress);
        if (!rateLimit.allowed) {
          setRateLimitHeaders(c, 0, rateLimit.resetAt);
          const retryAfterSec = Math.ceil((rateLimit.resetAt - Date.now()) / 1000);
          c.header("Retry-After", String(retryAfterSec));
          return c.json(
            {
              error: "Rate limit exceeded",
              detail: `Signature redemptions are limited to ${RATE_LIMIT_MAX} per 4-hour window.`,
              retryAfter: retryAfterSec,
            },
            429,
          );
        }

        const netHash = requestNetworkHash(c);
        const redemption = await redeemSignatureForSession(
          c.env.KV,
          authSignature,
          ts,
          netHash,
          () => mintSessionToken(c.env.KV, operatorAddress, netHash),
        );
        if (redemption.status === "network-mismatch") {
          return c.json(
            {
              error: "Signature already used",
              detail: "This signature was already redeemed from a different network. Please sign again to authenticate this device.",
            },
            401,
          );
        }
        c.set("operatorAuthVerified", true);
        c.set("operatorAuth", { address: operatorAddress, signature: authSignature, timestamp: ts });
        setRateLimitHeaders(c, rateLimit.remaining, rateLimit.resetAt);
        await next();
        c.header("X-Session-Token", redemption.token);
        // HttpOnly cookie: subsequent requests authenticate without JS ever
        // reading the token (XSS cannot exfiltrate it).
        c.header(
          "Set-Cookie",
          `${SESSION_COOKIE}=${redemption.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SEC}`,
        );
        return;
      }
    }

    await next();
  };
}
