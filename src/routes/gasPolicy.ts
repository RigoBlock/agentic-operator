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
import type { Address } from "viem";

const gasPolicy = new Hono<{ Bindings: Env }>();

/** KV prefix for agent wallet reverse lookup: agentAddress → vaultAddress */
const AGENT_REVERSE_KEY = "agent-reverse:";

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
    console.log(`[GasPolicy] sender=${sender} policyId=${policyId} chainId=${chainId}`);

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

      // ── 5. Approved (agent wallet) ──
      console.log(
        `[GasPolicy] ✓ APPROVED (agent): agent=${sender.slice(0, 10)}… vault=${vaultAddress.slice(0, 10)}… ` +
        `chain=${chainId} policy=${policyId}`,
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
          console.log(
            `[GasPolicy] ✓ APPROVED (user): sender=${sender.slice(0, 10)}… ` +
            `target vault=${innerTarget.slice(0, 10)}… chain=${chainId}`,
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
