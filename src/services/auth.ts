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

import { verifyMessage, type Address } from "viem";
import { isVaultOwner } from "./vault.js";
import { SUPPORTED_CHAINS, TESTNET_CHAINS } from "../config.js";

const AUTH_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * In-memory cache for verified operator+vault ownership.
 * Key: `${operator}:${vault}` (lowercased), Value: expiry timestamp.
 * Avoids 8+ RPC calls (one per chain) on every single chat message.
 */
const ownershipCache = new Map<string, number>();
const OWNERSHIP_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
  vaultAddress: string;
  authSignature: string;
  authTimestamp: number;
  /** Check this chain first before trying all others (avoids unnecessary RPC calls). */
  preferredChainId?: number;
  /** Alchemy API key — threaded from env, not stored in module state. */
  alchemyKey?: string;
}

/**
 * Verify that the caller is an authenticated vault operator.
 *
 * 1. Check timestamp is within 24h
 * 2. Verify signature matches claimed operatorAddress
 * 3. Verify signer is the vault owner on ANY supported chain
 *
 * Throws descriptive error on failure.
 */
export async function verifyOperatorAuth(params: AuthParams): Promise<void> {
  const { operatorAddress, vaultAddress, authSignature, authTimestamp } = params;

  if (!operatorAddress || !authSignature || authTimestamp == null) {
    throw new AuthError("Wallet not connected. Connect your wallet and sign to authenticate.", 401);
  }

  // 1. Validate timestamp type before arithmetic
  if (
    typeof authTimestamp !== "number" ||
    !Number.isFinite(authTimestamp) ||
    !Number.isInteger(authTimestamp)
  ) {
    throw new AuthError("Invalid auth timestamp. Expected an integer timestamp in milliseconds.", 401);
  }

  // 2. Check expiry
  const now = Date.now();
  if (now - authTimestamp > AUTH_EXPIRY_MS) {
    throw new AuthError("Authentication expired. Please reconnect your wallet.", 401);
  }
  if (authTimestamp > now + 60_000) {
    throw new AuthError("Invalid auth timestamp (future).", 401);
  }

  // 2. Verify signature (wallet-wide, no vault in message)
  // The signed message MUST include the timestamp to prevent replay attacks.
  // An attacker cannot reuse an old signature with a fresh timestamp because
  // the timestamp is cryptographically bound.
  let valid = false;
  try {
    const message = buildAuthMessage(operatorAddress, authTimestamp);
    valid = await verifyMessage({
      address: operatorAddress as Address,
      message,
      signature: authSignature as `0x${string}`,
    });
  } catch (err) {
    // verifyMessage throws when the signature is malformed (wrong length, bad encoding, etc.).
    // This is distinct from a well-formed signature that simply doesn't verify — report 401
    // so callers know the problem is format, not ownership.
    throw new AuthError(
      "Invalid signature format: " +
      (err instanceof Error ? err.message : "signature could not be decoded") +
      ". Ensure the authSignature is a valid 65-byte EIP-191 hex string.",
      401,
    );
  }

  if (!valid) {
    throw new AuthError(
      "Signature verification failed. The signature does not match the operator address or the timestamp. " +
      "Ensure your client includes the authTimestamp in the signed message.",
      403,
    );
  }

  // 3. Check ownership cache first — avoids 8+ RPC calls per message
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
  const { preferredChainId, alchemyKey } = params;
  if (preferredChainId) {
    try {
      const isOwner = await isVaultOwner(preferredChainId, vaultAddress as Address, operatorAddress as Address, alchemyKey);
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
      return await isVaultOwner(chain.id, vaultAddress as Address, operatorAddress as Address, alchemyKey);
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
