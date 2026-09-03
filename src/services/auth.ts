/**
 * Operator authentication — signature-based access gating.
 *
 * Only Rigoblock vault owners can use the AI assistant.
 * Flow:
 *   1. Frontend: user signs a human-readable message (wallet-wide, not vault-specific, chain-independent)
 *   2. Backend: verifies signature → checks vault ownership across ALL supported chains
 *   3. Verified operators can use chat/quote endpoints
 *
 * The auth signature proves wallet ownership. Vault ownership is checked
 * across all supported chains so a vault on Ethereum mainnet grants access
 * even when the user is trading on Base.
 *
 * Signatures are valid for 24 hours.
 */

import { verifyMessage, isAddress, type Address } from "viem";
import { AsyncLocalStorage } from "node:async_hooks";
import { isVaultOwner } from "./vault.js";
import { SUPPORTED_CHAINS, TESTNET_CHAINS } from "../config.js";
import { getEnv } from "./envContext.js";

const AUTH_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * In-memory cache for verified operator+vault ownership.
 * Key: `${operator}:${vault}` (lowercased), Value: expiry timestamp.
 * Avoids 8+ RPC calls (one per chain) on every single chat message.
 */
const ownershipCache = new Map<string, number>();
const OWNERSHIP_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Anti-replay store: highest consumed authTimestamp per operator address.
 * A captured (address, signature, timestamp) triple is otherwise replayable by
 * anyone for the full 24h signature validity window. Requiring strictly
 * increasing timestamps per address means a previously seen triple can never
 * be accepted again.
 *
 * KV (`auth:ts:{address}`) is authoritative when available; the in-memory map
 * mirrors it so non-worker contexts (unit tests, scripts) still get partial
 * protection within a single process.
 */
const authTimestampCache = new Map<string, number>();
const AUTH_TS_TTL_SECONDS = 25 * 60 * 60; // 25h — covers the 24h signature window

/**
 * Request-scoped record of (address, timestamp) pairs already consumed during
 * the current request. A single logical request legitimately verifies the same
 * credentials twice — the x402 middleware verifies the X-Auth-* headers, then
 * the route handler calls verifyOperatorAuth with the same signature to check
 * vault ownership. Without request-scoped idempotency, the anti-replay
 * monotonicity check would reject the second verification of the SAME triple
 * (its timestamp is no longer strictly newer than the one the middleware just
 * recorded), producing an unfixable re-authentication loop.
 *
 * Cross-request replay protection is unchanged: this store is created fresh
 * per request (AsyncLocalStorage) and consulted only within it. Reusing the
 * same triple in a LATER request is still rejected by the KV-backed monotonicity
 * check below. Only triples whose signature has already verified are recorded.
 */
const authRequestScope = new AsyncLocalStorage<Set<string>>();

/** Run `fn` with a fresh per-request auth-consumption scope. */
export function withAuthRequestScope<T>(fn: () => T): T {
  return authRequestScope.run(new Set<string>(), fn);
}

/**
 * Reject authTimestamps that are not strictly newer than the highest one
 * already consumed for this address, then record the new maximum.
 *
 * Idempotent within a single request (see authRequestScope): the same verified
 * triple may be consumed more than once when the x402 middleware AND the route
 * handler both authenticate the same credentials. Across requests, consumption
 * is strictly monotonic.
 *
 * MUST only be called AFTER the signature has verified — otherwise an
 * attacker could burn a victim's timestamp window without knowing the key.
 */
async function enforceAuthTimestampMonotonicity(
  operatorAddress: string,
  authTimestamp: number,
): Promise<void> {
  const key = `auth:ts:${operatorAddress.toLowerCase()}`;
  const kv = getEnv()?.KV;

  // Same-request idempotency: the middleware and the route may both verify the
  // identical triple within one request. The signature has already verified at
  // this point, and the triple passed the monotonicity check on first use.
  // Keyed by address + timestamp so a DIFFERENT timestamp in the same request
  // is still evaluated against the monotonicity store.
  const seen = authRequestScope.getStore();
  const seenKey = `${key}:${authTimestamp}`;
  if (seen?.has(seenKey)) {
    return;
  }

  let stored: number | undefined;
  if (kv) {
    try {
      const raw = await kv.get(key);
      if (raw != null) stored = Number(raw);
    } catch {
      // KV read failed — fall back to the in-memory mirror below.
    }
  }
  if (stored === undefined || Number.isNaN(stored)) {
    stored = authTimestampCache.get(key);
  }

  if (stored !== undefined && authTimestamp <= stored) {
    throw new AuthError(
      "Authentication replay detected. This signature was already used. " +
      "Please sign a fresh authentication message with a newer timestamp.",
      401,
    );
  }

  const newMax = Math.max(stored ?? 0, authTimestamp);
  authTimestampCache.set(key, newMax);
  seen?.add(seenKey);
  if (kv) {
    try {
      await kv.put(key, String(newMax), { expirationTtl: AUTH_TS_TTL_SECONDS });
    } catch {
      // KV write failed — the in-memory mirror still protects this process.
    }
  }
}

/**
 * Build the exact message the frontend must sign.
 * Wallet-wide — NOT tied to any specific vault or chain.
 * Human-readable so the wallet UI shows a clear description of what is being signed.
 *
 * The timestamp is included in the message to prevent signature replay attacks.
 * An attacker who steals a signature cannot replay it with a fresh timestamp,
 * because the timestamp is cryptographically bound to the signature.
 */
export function buildAuthMessage(_address: string, timestamp?: number): string {
  if (timestamp !== undefined) {
    return [
      "Welcome to Rigoblock Operator",
      "",
      "Sign this message to verify your wallet and access your smart pool assistant.",
      "",
      `Timestamp: ${timestamp}`,
    ].join("\n");
  }
  // Legacy format (deprecated — kept for transition period only)
  return [
    "Welcome to Rigoblock Operator",
    "",
    "Sign this message to verify your wallet and access your smart pool assistant.",
  ].join("\n");
}

export interface AuthParams {
  operatorAddress: string;
  vaultAddress?: string;
  authSignature: string;
  authTimestamp: number;
  /** Check this chain first before trying all others (avoids unnecessary RPC calls). */
  preferredChainId?: number;
}

/**
 * Shared signature verification — throws AuthError with specific messages.
 * Used by both verifyOperatorAuth (route handlers) and verifyOperatorSignatureOnly (middleware).
 */
async function _verifyOperatorSignature(
  operatorAddress: string,
  authSignature: string,
  authTimestamp: number,
): Promise<void> {
  if (!operatorAddress || !authSignature || authTimestamp == null) {
    throw new AuthError("Wallet not connected. Connect your wallet and sign to authenticate.", 401);
  }

  if (
    typeof authTimestamp !== "number" ||
    !Number.isFinite(authTimestamp) ||
    !Number.isInteger(authTimestamp)
  ) {
    throw new AuthError("Invalid auth timestamp. Expected an integer timestamp in milliseconds.", 401);
  }

  const now = Date.now();
  if (now - authTimestamp > AUTH_EXPIRY_MS) {
    throw new AuthError("Authentication expired. Please reconnect your wallet.", 401);
  }
  if (authTimestamp > now + 60_000) {
    throw new AuthError("Invalid auth timestamp (future).", 401);
  }

  if (!isAddress(operatorAddress)) {
    throw new AuthError(
      "Invalid operator address format. Expected a valid EVM address (0x + 40 hex chars).",
      400,
    );
  }

  try {
    const message = buildAuthMessage(operatorAddress, authTimestamp);
    const valid = await verifyMessage({
      address: operatorAddress as Address,
      message,
      signature: authSignature as `0x${string}`,
    });
    if (!valid) {
      throw new AuthError(
        "Signature verification failed. The signature does not match the operator address or the timestamp. " +
        "Ensure your client includes the authTimestamp in the signed message.",
        403,
      );
    }
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError(
      "Invalid signature format: " +
      (err instanceof Error ? err.message : "signature could not be decoded") +
      ". Ensure the authSignature is a valid 65-byte EIP-191 hex string.",
      401,
    );
  }

  // Anti-replay: only after the signature has verified, reject timestamps that
  // are not strictly newer than the highest one already consumed for this
  // address, then record the new maximum (KV + in-memory mirror).
  await enforceAuthTimestampMonotonicity(operatorAddress, authTimestamp);
}

/**
 * Lightweight signature verification — returns boolean instead of throwing.
 * Used by x402 middleware to skip payment for authenticated operators.
 *
 * The client-facing 401 is intentionally generic; the real rejection reason is
 * logged server-side (worker contexts only) so misconfigurations and regressions
 * are visible in production logs.
 */
export async function verifyOperatorSignatureOnly(
  operatorAddress: string,
  authSignature: string,
  authTimestamp: number,
): Promise<boolean> {
  try {
    await _verifyOperatorSignature(operatorAddress, authSignature, authTimestamp);
    return true;
  } catch (err) {
    if (getEnv()) {
      console.warn(
        `[auth] operator signature rejected for ${operatorAddress}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return false;
  }
}

/**
 * Verify that the caller is an authenticated vault operator.
 * 1. Verify signature via _verifyOperatorSignature
 * 2. Verify signer is the vault owner on ANY supported chain
 *
 * Throws descriptive AuthError on failure.
 */
export async function verifyOperatorAuth(params: AuthParams): Promise<void> {
  const { operatorAddress, vaultAddress, authSignature, authTimestamp } = params;
  await _verifyOperatorSignature(operatorAddress, authSignature, authTimestamp);

  // Vault ownership check — skip when no vault is provided (operator-scoped tools
  // like set_swap_shield_tolerance don't require a vault context).
  if (!vaultAddress) {
    return; // signature verified, no vault to own
  }
  if (!isAddress(vaultAddress)) {
    throw new AuthError(
      "Invalid vault address format. Expected a valid EVM address (0x + 40 hex chars).",
      400,
    );
  }

  // 4. Check ownership cache first — avoids 8+ RPC calls per message
  const cacheKey = `${operatorAddress.toLowerCase()}:${vaultAddress.toLowerCase()}`;
  const cachedExpiry = ownershipCache.get(cacheKey);
  if (cachedExpiry && Date.now() < cachedExpiry) {
    return; // ownership recently verified
  }
  // Negative cache: confirmed non-owners skip the RPC fan-out
  const nonOwnerKey = `nonowner:${cacheKey}`;
  const cachedNonOwner = ownershipCache.get(nonOwnerKey);
  if (cachedNonOwner && Date.now() < cachedNonOwner) {
    throw new AuthError(
      `Access denied: ${operatorAddress.slice(0, 6)}…${operatorAddress.slice(-4)} is not the owner of vault ${vaultAddress.slice(0, 6)}…${vaultAddress.slice(-4)} on any supported chain.`,
      403,
    );
  }

  // 4. Check vault ownership — preferred chain first, then the rest in parallel.
  //    This avoids 8 parallel RPC calls when the vault is on the selected chain.
  const { preferredChainId } = params;
  if (preferredChainId) {
    try {
      const isOwner = await isVaultOwner(preferredChainId, vaultAddress as Address, operatorAddress as Address);
      if (isOwner) {
        ownershipCache.set(cacheKey, Date.now() + OWNERSHIP_CACHE_TTL_MS);
        return;
      }
    } catch {
      // Vault may not exist on this chain — fall through to check others
    }
  }

  // Fall back: check all OTHER supported chains in parallel
  const allChains = [...SUPPORTED_CHAINS, ...TESTNET_CHAINS].filter(
    (c) => c.id !== preferredChainId,
  );
  const ownerChecks = allChains.map(async (chain) => {
    try {
      return await isVaultOwner(chain.id, vaultAddress as Address, operatorAddress as Address);
    } catch {
      // Chain RPC failure or vault doesn't exist on this chain — skip
      return false;
    }
  });

  const results = await Promise.all(ownerChecks);
  const isOwnerOnAny = results.some(Boolean);

  if (!isOwnerOnAny) {
    ownershipCache.set(nonOwnerKey, Date.now() + OWNERSHIP_CACHE_TTL_MS);
    throw new AuthError(
      `Access denied: ${operatorAddress.slice(0, 6)}…${operatorAddress.slice(-4)} is not the owner of vault ${vaultAddress.slice(0, 6)}…${vaultAddress.slice(-4)} on any supported chain. Only the vault operator can use this assistant.`,
      403,
    );
  }

  // Cache successful verification
  ownershipCache.set(cacheKey, Date.now() + OWNERSHIP_CACHE_TTL_MS);
}

/**
 * Custom error with HTTP status code.
 */
export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}
