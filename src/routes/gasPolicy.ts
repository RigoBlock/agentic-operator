/**
 * Gas Policy Webhook — POST /api/gas-policy
 *
 * Alchemy Gas Manager "Custom Rules" webhook. Alchemy calls this endpoint
 * to verify whether a UserOperation should be gas-sponsored.
 *
 * ## How it works
 *
 * 1. Our SDK calls `prepareCalls()` with `paymasterService: { policyId }`
 * 2. Alchemy's Gas Manager receives the request and builds a UserOp
 * 3. Before sponsoring, Alchemy POSTs to this webhook with the UserOp details
 * 4. We validate: is the sender a registered agent wallet for a known vault?
 * 5. We respond `{ "approved": true }` to sponsor, or `{ "approved": false }` to reject
 * 6. Alchemy sponsors the gas and returns paymaster data to the SDK
 *
 * ## Alchemy webhook format (from docs)
 *
 * Request (POST from Alchemy):
 * ```json
 * {
 *   "userOperation": {
 *     "sender": "0x...",     // our agent wallet EOA (EIP-7702)
 *     "callData": "0x...",   // encoded execute() wrapping our vault call
 *     "nonce": "0x...",
 *     ...
 *   },
 *   "policyId": "...",
 *   "chainId": "0xa4b1",
 *   "webhookData": ""
 * }
 * ```
 *
 * Response (HTTP 200):
 * - Approve: `{ "approved": true }`
 * - Reject:  `{ "approved": false }`
 *
 * Reference: https://docs.alchemy.com/docs/conditional-gas-sponsorship
 */

import { Hono } from "hono";
import type { Env } from "../types.js";
import { getDelegationConfig } from "../services/delegation.js";
import { convertTokenAmountViaOracle } from "../services/oraclePrice.js";
import { CROSSCHAIN_TOKENS } from "../services/crosschainConfig.js";
import { formatUnits, parseUnits, type Address } from "viem";

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** All spending tracking is done in 18-decimal fixed point to avoid float errors */
const SPENDING_DECIMALS = 18;

/** Normalize a raw token amount to 18 decimals using exact bigint math */
function normalizeTo18Decimals(raw: bigint, decimals: number): bigint {
  if (decimals === SPENDING_DECIMALS) return raw;
  if (decimals < SPENDING_DECIMALS) {
    return raw * 10n ** BigInt(SPENDING_DECIMALS - decimals);
  }
  return raw / 10n ** BigInt(decimals - SPENDING_DECIMALS);
}

/** Get USDC address and decimals for a chain from the authoritative cross-chain token map */
function getUsdcInfo(chainId: number): { address: Address; decimals: number } | null {
  const tokens = CROSSCHAIN_TOKENS[chainId];
  if (!tokens) return null;
  const usdc = tokens.find((t) => t.type === "USDC");
  if (!usdc) return null;
  return { address: usdc.address, decimals: usdc.decimals };
}

const gasPolicy = new Hono<{ Bindings: Env }>();

/** KV prefix for agent wallet reverse lookup: agentAddress → vaultAddress */
const AGENT_REVERSE_KEY = "agent-reverse:";

/** KV prefix for per-wallet daily gas sponsorship spend tracking */
const GAS_SPEND_KEY = "gas-spend:";

/** Default daily gas sponsorship limit per wallet in USD */
export const DEFAULT_GAS_SPENDING_LIMIT_USD = 5;

/** Parse a chainId that may be a hex string, decimal string, or number */
function parseChainId(value: unknown): number {
  if (typeof value === "number") return value;
  const s = String(value).trim();
  if (s.startsWith("0x") || s.startsWith("0X")) return parseInt(s, 16) || 0;
  return parseInt(s, 10) || 0;
}

/** Parse UserOperation gas fields that may be hex strings, decimal strings, or numbers */
export function parseBigInt(value: unknown): bigint {
  if (value === undefined || value === null) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.floor(value));
  const s = String(value).trim();
  if (s === "") return 0n;
  return BigInt(s);
}

/** Return the current UTC day bucket in YYYY-MM-DD format (resets at UTC midnight) */
export function getCurrentDayBucket(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Estimate the max gas cost of a UserOperation in USD.
 * Returns null if the chain has no WETH/USDC oracle feed or the oracle call fails.
 */
export async function estimateGasCostUsd(
  chainId: number,
  userOp: Record<string, unknown>,
  alchemyKey: string,
): Promise<{ usd: number; rawNormalized: bigint } | null> {
  const maxFeePerGas = parseBigInt(userOp.maxFeePerGas);
  const callGasLimit = parseBigInt(userOp.callGasLimit);
  const verificationGasLimit = parseBigInt(userOp.verificationGasLimit);
  const preVerificationGas = parseBigInt(userOp.preVerificationGas);

  const totalGas = callGasLimit + verificationGasLimit + preVerificationGas;
  if (totalGas <= 0n || maxFeePerGas <= 0n) {
    return { usd: 0, rawNormalized: 0n };
  }

  const gasCostWei = totalGas * maxFeePerGas;
  const usdcInfo = getUsdcInfo(chainId);

  if (!usdcInfo) {
    console.warn(`[GasPolicy] No USDC configured for chain ${chainId}; cannot estimate USD`);
    return null;
  }

  try {
    // Use native currency (0x0) as the source token. The BackgeoOracle indexes
    // every pool as native-vs-token, and oraclePrice.ts normalizes wrapped-native
    // to 0x0 anyway. Using 0x0 directly guarantees the correct pool ordering.
    const usdcRaw = await convertTokenAmountViaOracle(
      chainId,
      NATIVE_TOKEN_ADDRESS,
      gasCostWei,
      usdcInfo.address,
      alchemyKey,
    );
    const rawNormalized = normalizeTo18Decimals(usdcRaw, usdcInfo.decimals);
    return { usd: parseFloat(formatUnits(rawNormalized, SPENDING_DECIMALS)), rawNormalized };
  } catch (err) {
    console.warn(
      `[GasPolicy] USD estimation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Enforce a per-wallet daily gas sponsorship spending limit.
 * On chains where USD estimation is unavailable the check is skipped (logs a warning).
 */
export async function checkSpendingLimit(
  kv: KVNamespace,
  sender: Address,
  chainId: number,
  userOp: Record<string, unknown>,
  alchemyKey: string,
  limitUsdRaw: bigint,
  now?: number,
): Promise<{
  approved: boolean;
  reason?: string;
  currentSpend?: number;
  estimatedCost?: number;
  limit?: number;
}> {
  const estimated = await estimateGasCostUsd(chainId, userOp, alchemyKey);
  if (estimated === null) {
    console.warn(`[GasPolicy] Skipping spending limit: USD estimation unavailable for chain ${chainId}`);
    return { approved: true };
  }

  const limitUsd = parseFloat(formatUnits(limitUsdRaw, SPENDING_DECIMALS));

  if (estimated.rawNormalized === 0n) {
    return { approved: true, estimatedCost: 0, limit: limitUsd };
  }

  const dayBucket = getCurrentDayBucket(now);
  const spendKey = `${GAS_SPEND_KEY}${sender.toLowerCase()}:${dayBucket}`;
  const currentSpendRaw = await kv.get(spendKey);
  const currentSpendNormalized = currentSpendRaw ? BigInt(currentSpendRaw) : 0n;

  if (currentSpendNormalized + estimated.rawNormalized > limitUsdRaw) {
    const currentSpend = parseFloat(formatUnits(currentSpendNormalized, SPENDING_DECIMALS));
    return {
      approved: false,
      reason:
        `Daily gas sponsorship limit exceeded for ${sender.slice(0, 10)}…: ` +
        `$${currentSpend.toFixed(4)} already spent + $${estimated.usd.toFixed(4)} estimated > $${limitUsd.toFixed(4)} daily limit ` +
        `(resets at UTC midnight)`,
      currentSpend,
      estimatedCost: estimated.usd,
      limit: limitUsd,
    };
  }

  const newSpendNormalized = currentSpendNormalized + estimated.rawNormalized;
  await kv.put(spendKey, newSpendNormalized.toString());
  return {
    approved: true,
    currentSpend: parseFloat(formatUnits(newSpendNormalized, SPENDING_DECIMALS)),
    estimatedCost: estimated.usd,
    limit: limitUsd,
  };
}

// ── GET /api/gas-policy — health check ────────────────────────────────
gasPolicy.get("/", (c) =>
  c.json({ ok: true, route: "/api/gas-policy", ts: Date.now() }),
);

// ── POST /api/gas-policy — Alchemy webhook ────────────────────────────
gasPolicy.post("/", async (c) => {
  try {
    const rawBody = await c.req.text();
    console.log(`[GasPolicy] Webhook received (${rawBody.length} bytes): ${rawBody.slice(0, 600)}`);

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      console.error("[GasPolicy] Failed to parse JSON body");
      return c.json({ approved: false }, 200);
    }

    // ── Extract sender from userOperation ─────────────────────────────
    // Alchemy sends: { userOperation: { sender, callData, ... }, policyId, chainId, webhookData }
    const userOp = body.userOperation;
    const policyId = body.policyId || "";
    const chainId = body.chainId || "";

    if (!userOp || !userOp.sender) {
      // If format is unexpected, log everything we received and fail-open
      // (on-chain caveats are the real protection)
      console.warn("[GasPolicy] No userOperation.sender in request");
      console.warn(`[GasPolicy] Body keys: ${Object.keys(body).join(", ")}`);
      return c.json({ approved: true }, 200);
    }

    const sender = userOp.sender.toLowerCase() as Address;
    const chainIdNumber = parseChainId(chainId);
    const gasLimitUsdRaw = parseUnits(
      c.env.GAS_SPENDING_LIMIT_USD || String(DEFAULT_GAS_SPENDING_LIMIT_USD),
      SPENDING_DECIMALS,
    );
    const gasLimitUsdDisplay = formatUnits(gasLimitUsdRaw, SPENDING_DECIMALS);
    console.log(`[GasPolicy] sender=${sender} policyId=${policyId} chainId=${chainId} chainIdNumber=${chainIdNumber} limitUsd=${gasLimitUsdDisplay}`);

    // ── 1. Check if sender is a registered agent wallet ──
    const vaultAddress = await resolveAgentToVault(c.env.KV, sender);

    if (vaultAddress) {
      // ── Agent wallet path: full delegation checks ──
      console.log(`[GasPolicy] sender maps to vault=${vaultAddress}`);

      // ── 2. Verify delegation is active ──
      const config = await getDelegationConfig(c.env.KV, vaultAddress);
      if (!config || !config.enabled) {
        console.warn(`[GasPolicy] ✗ REJECTED: delegation not active for vault ${vaultAddress}`);
        return c.json({ approved: false }, 200);
      }

      // ── 3. Verify the agent address matches delegation config ──
      if (config.agentAddress.toLowerCase() !== sender) {
        console.warn(
          `[GasPolicy] ✗ REJECTED: agent mismatch sender=${sender} vs config=${config.agentAddress}`,
        );
        return c.json({ approved: false }, 200);
      }

      // ── 4. Decode callData to verify target is the vault ──
      const callData = userOp.callData;
      if (callData && callData.length >= 10) {
        const innerTarget = tryExtractTarget(callData);
        if (innerTarget) {
          const isVault = innerTarget.toLowerCase() === vaultAddress.toLowerCase();
          console.log(`[GasPolicy] Inner target=${innerTarget} isVault=${isVault}`);
          if (!isVault) {
            console.warn(
              `[GasPolicy] ✗ REJECTED: inner target ${innerTarget} is not vault ${vaultAddress}`,
            );
            return c.json({ approved: false }, 200);
          }
        } else {
          console.log("[GasPolicy] Could not decode inner target — approving (on-chain caveats enforce)");
        }
      }

      // ── 5. Per-wallet daily spending limit ──
      const spendCheck = await checkSpendingLimit(
        c.env.KV, sender, chainIdNumber, userOp, c.env.ALCHEMY_API_KEY, gasLimitUsdRaw,
      );
      if (!spendCheck.approved) {
        console.warn(`[GasPolicy] ✗ REJECTED: ${spendCheck.reason}`);
        return c.json({ approved: false, reason: spendCheck.reason }, 200);
      }

      // ── 6. Approved (agent wallet) ──
      console.log(
        `[GasPolicy] ✓ APPROVED (agent): agent=${sender.slice(0, 10)}… vault=${vaultAddress.slice(0, 10)}… ` +
        `chain=${chainId} policy=${policyId} spend=$${spendCheck.currentSpend?.toFixed(4)} limit=$${gasLimitUsdDisplay}`,
      );
      return c.json({ approved: true }, 200);
    }

    // ── User wallet path: sponsor vault interactions ──
    // If the sender is NOT a registered agent wallet, check if their
    // transaction targets a known vault. This sponsors user setup
    // transactions (pool deployment, delegation setup, funding).
    const callData = userOp.callData;
    if (callData && callData.length >= 10) {
      const innerTarget = tryExtractTarget(callData);
      if (innerTarget) {
        // Check if the target is a vault with an agent wallet configured
        const targetConfig = await getDelegationConfig(
          c.env.KV,
          innerTarget.toLowerCase(),
        );
        // Also check if there's any agent wallet registered for this vault
        const agentWalletInfo = await c.env.KV.get(`agent-wallet:${innerTarget.toLowerCase()}`);

        if (targetConfig || agentWalletInfo) {
          // ── Per-wallet daily spending limit (user wallet path) ──
          const spendCheck = await checkSpendingLimit(
            c.env.KV, sender, chainIdNumber, userOp, c.env.ALCHEMY_API_KEY, gasLimitUsdRaw,
          );
          if (!spendCheck.approved) {
            console.warn(`[GasPolicy] ✗ REJECTED: ${spendCheck.reason}`);
            return c.json({ approved: false, reason: spendCheck.reason }, 200);
          }

          console.log(
            `[GasPolicy] ✓ APPROVED (user): sender=${sender.slice(0, 10)}… ` +
            `target vault=${innerTarget.slice(0, 10)}… chain=${chainId} spend=$${spendCheck.currentSpend?.toFixed(4)} limit=$${gasLimitUsdDisplay}`,
          );
          return c.json({ approved: true }, 200);
        }
      }
    }

    console.warn(`[GasPolicy] ✗ REJECTED: sender ${sender} is not an agent wallet and target is not a known vault`);
    return c.json({ approved: false }, 200);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[GasPolicy] Webhook error: ${msg}`);
    // Fail-open: on-chain caveats are the real protection
    return c.json({ approved: true }, 200);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Resolve an agent wallet address → vault address.
 * Uses KV reverse lookup, with a slow-path fallback scan.
 */
async function resolveAgentToVault(
  kv: KVNamespace,
  agentAddress: string,
): Promise<string | null> {
  // Fast path: reverse lookup
  const cached = await kv.get(`${AGENT_REVERSE_KEY}${agentAddress.toLowerCase()}`);
  if (cached) return cached;

  // Slow path: scan all agent-wallet:* keys
  const list = await kv.list({ prefix: "agent-wallet:" });
  for (const key of list.keys) {
    const raw = await kv.get(key.name);
    if (!raw) continue;
    try {
      const info = JSON.parse(raw);
      if (info.address?.toLowerCase() === agentAddress.toLowerCase()) {
        const vaultAddr = info.vaultAddress || key.name.replace("agent-wallet:", "");
        await kv.put(`${AGENT_REVERSE_KEY}${agentAddress.toLowerCase()}`, vaultAddr);
        return vaultAddr;
      }
    } catch { /* skip malformed */ }
  }

  return null;
}

/**
 * Try to extract the inner call target from the userOp callData.
 *
 * For EIP-7702 accounts, the callData is typically:
 *   - execute(address target, uint256 value, bytes data) → selector 0xb61d27f6
 *   - executeBatch(Call[]) → various selectors
 *
 * We try common patterns. Returns null if we can't decode.
 */
function tryExtractTarget(callData: string): string | null {
  try {
    const selector = callData.slice(0, 10).toLowerCase();

    // Pattern 1: execute(address, uint256, bytes) — 0xb61d27f6
    if (selector === "0xb61d27f6") {
      const targetHex = callData.slice(10, 74);
      return "0x" + targetHex.slice(24);
    }

    // Pattern 2: Any function where first param is a padded address
    if (callData.length > 74) {
      const firstWord = callData.slice(10, 74);
      if (firstWord.startsWith("000000000000000000000000")) {
        const addr = "0x" + firstWord.slice(24);
        if (addr !== "0x0000000000000000000000000000000000000000") {
          return addr;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

export { gasPolicy };
