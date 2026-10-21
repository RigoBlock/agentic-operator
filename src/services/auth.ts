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

import { verifyMessage, isAddress, sha256, type Address, type Hex } from "viem";
import { isVaultOwner } from "./vault.js";
import { SUPPORTED_CHAINS, TESTNET_CHAINS } from "../config.js";
import { getEnv } from "./envContext.js";

const AUTH_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Session tokens ────────────────────────────────────────────────────
//
// A verified auth signature is REDEEMED ONCE for an opaque session token
// (KV-gated; without KV the legacy replayable-behavior remains, dev only).
// The raw (address, signature, timestamp) triple alone no longer skips
// payment in production: a captured signature yields nothing once redeemed.
// Sessions are bound to a salted hash of (IP, User-Agent) so a token minted
// for one network is not usable from another — roaming clients just re-sign.
// Redemption is idempotent per network so concurrent page-load requests with
// the same fresh signature all resolve to the same session; the same
// signature presented from a DIFFERENT network is rejected (401, re-sign).

const SESSION_TTL_SEC = 24 * 60 * 60;
const SESSION_KV_PREFIX = "sess:";
const REDEEM_KV_PREFIX = "sess-redeem:";

/**
 * Pepper for the network hash. Not a secret against code access — it only
 * ensures a KV dump exposes hashes, not raw IPs / user-agent strings.
 */
const NETWORK_HASH_PEPPER = "rigoblock-network-hash-v1";

/** Salted hash binding a session to the caller's observed network context. */
export function computeNetworkHash(ip: string, userAgent: string): string {
  return sha256(
    (NETWORK_HASH_PEPPER + "|" + ip + "|" + userAgent) as Hex,
  );
}

interface SessionRecord {
  address: string;
  networkHash: string;
  createdAt: number;
}

export async function mintSessionToken(
  kv: KVNamespace,
  operatorAddress: string,
  networkHash: string,
): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = ("0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
  const record: SessionRecord = {
    address: operatorAddress.toLowerCase(),
    networkHash,
    createdAt: Date.now(),
  };
  await kv.put(SESSION_KV_PREFIX + sha256(token), JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SEC,
  });
  return token;
}

/**
 * Validate a session token against the caller's network hash.
 * Returns the bound operator address, or null when unknown / expired /
 * presented from a different network (caller must re-authenticate).
 */
export async function verifySessionToken(
  kv: KVNamespace,
  token: string,
  networkHash: string,
): Promise<{ address: string } | null> {
  if (!token || !/^0x[0-9a-fA-F]{64}$/.test(token)) return null;
  let record: SessionRecord | null = null;
  try {
    record = await kv.get<SessionRecord>(SESSION_KV_PREFIX + sha256(token as Hex), "json");
  } catch {
    return null;
  }
  if (!record || !record.address) return null;
  if (record.networkHash && record.networkHash !== networkHash) return null;
  return { address: record.address };
}

export type RedemptionResult =
  | { status: "minted"; token: string }
  | { status: "reissued"; token: string }
  | { status: "network-mismatch" };

interface RedemptionRecord {
  sessionToken: string;
  networkHash: string;
}

/**
 * Redeem a verified auth signature for a session token.
 * First presentation from a network mints a fresh session; re-presentation
 * from the SAME network re-issues the same session (idempotent — concurrent
 * page-load requests share one signature); presentation from a DIFFERENT
 * network is rejected. The redemption record outlives the signature's own
 * validity, so an expired signature can never be redeemed again.
 */
export async function redeemSignatureForSession(
  kv: KVNamespace,
  authSignature: string,
  authTimestamp: number,
  networkHash: string,
  mint: () => Promise<string>,
): Promise<RedemptionResult> {
  const now = Date.now();
  const remainingMs = authTimestamp + AUTH_EXPIRY_MS - now;
  const ttlSec = Math.max(60, Math.min(SESSION_TTL_SEC, Math.floor(remainingMs / 1000)));
  const rKey = REDEEM_KV_PREFIX + sha256(authSignature as Hex);
  const existing = await kv.get<RedemptionRecord>(rKey, "json");
  if (existing?.sessionToken) {
    if (existing.networkHash === networkHash) {
      return { status: "reissued", token: existing.sessionToken };
    }
    return { status: "network-mismatch" };
  }
  const token = await mint();
  const record: RedemptionRecord = { sessionToken: token, networkHash };
  await kv.put(rKey, JSON.stringify(record), { expirationTtl: ttlSec });
  return { status: "minted", token };
}

/**
 * In-memory cache for verified operator+vault ownership.
 * Key: `${operator}:${vault}` (lowercased), Value: expiry timestamp.
 * Avoids 8+ RPC calls (one per chain) on every single chat message.
 */
const ownershipCache = new Map<string, number>();
const OWNERSHIP_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Verification is IDEMPOTENT within the signature's validity window: the
 * frontend caches one wallet signature per address (localStorage, 23h) and
 * reuses it for every request, including delegated executions — so a still
 * valid (address, signature, timestamp) triple must be accepted on every
 * presentation. Replay protection comes from the cryptographic binding of the
 * timestamp into the signed message (a captured signature cannot be presented
 * with a different or fresher timestamp) and from the bounded 24h window.
 * Single-use semantics were tried and rejected: they break the cached session
 * and add no real security, since only the keyholder can mint a fresh
 * credential anyway.
 */

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

  await checkVaultOwnership(operatorAddress, vaultAddress as Address, params.preferredChainId);
}

/**
 * Vault-ownership check WITHOUT a signature — for requests the x402
 * middleware already authenticated via a session token. The middleware is
 * the credential gate; here we only prove the session's address owns the
 * request's vault (or skip when no vault is provided, same as
 * verifyOperatorAuth).
 */
export async function verifyOperatorOwnership(params: {
  operatorAddress: string;
  vaultAddress?: string;
  preferredChainId?: number;
}): Promise<void> {
  if (!params.vaultAddress) return;
  if (!isAddress(params.operatorAddress) || !isAddress(params.vaultAddress)) {
    throw new AuthError("Invalid operator or vault address format.", 400);
  }
  await checkVaultOwnership(
    params.operatorAddress,
    params.vaultAddress as Address,
    params.preferredChainId,
  );
}

/**
 * Shared ownership logic used by verifyOperatorAuth and verifyOperatorOwnership.
 */
async function checkVaultOwnership(
  operatorAddress: string,
  vaultAddress: Address,
  preferredChainId?: number,
): Promise<void> {
  // Check ownership cache first — avoids 8+ RPC calls per message
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
