/**
 * Delegation routes — POST /api/delegation/*
 *
 * API endpoints for managing EIP-7702 delegation between the pool operator
 * and the agent wallet. All endpoints require authentication.
 *
 * Routes:
 *   POST /api/delegation/setup    → Prepare delegation (returns unsigned delegation for signing)
 *   POST /api/delegation/confirm  → Confirm delegation was set up on-chain
 *   POST /api/delegation/revoke   → Revoke delegation
 *   GET  /api/delegation/status   → Check delegation status for a vault
 *   GET  /api/delegation/balance  → Check agent wallet ETH balance
 */

import { Hono } from "hono";
import type { Env } from "../types.js";
import { verifyOperatorAuth, AuthError } from "../services/auth.js";
import { prepareDelegation, confirmDelegation, revokeDelegation, getDelegationConfig } from "../services/delegation.js";
import { getAgentWalletInfo, deleteAgentWallet } from "../services/agentWallet.js";
import { checkAgentBalance, ExecutionError } from "../services/execution.js";
import { sanitizeError } from "../config.js";
import type { Address, Hex } from "viem";

const delegation = new Hono<{ Bindings: Env }>();

/**
 * POST /api/delegation/setup
 *
 * Prepare a delegation for the operator to sign.
 * Creates the agent wallet (if needed) and returns the unsigned
 * delegation object + caveats for the frontend to present to the operator.
 *
 * Body: { operatorAddress, vaultAddress, chainId, authSignature, authTimestamp }
 */
delegation.post("/setup", async (c) => {
  try {
    const body = await c.req.json<{
      operatorAddress: string;
      vaultAddress: string;
      chainId: number;
      authSignature: string;
      authTimestamp: number;
    }>();

    // Auth gate
    await verifyOperatorAuth({
      operatorAddress: body.operatorAddress,
      vaultAddress: body.vaultAddress,
      authSignature: body.authSignature,
      authTimestamp: body.authTimestamp,
      preferredChainId: body.chainId,
      alchemyKey: c.env.ALCHEMY_API_KEY,
    });

    const result = await prepareDelegation(
      c.env,
      body.operatorAddress as Address,
      body.vaultAddress as Address,
      body.chainId,
    );

    return c.json({
      agentAddress: result.agentAddress,
      delegation: {
        ...result.delegation,
        salt: result.delegation.salt.toString(), // BigInt → string for JSON
      },
      caveats: result.caveats,
      allowedSelectors: result.allowedSelectors,
      message: `Agent wallet ${result.agentAddress} created. Sign the delegation in your wallet to grant it permission to execute trades on your vault.`,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: err.message }, err.status as 401 | 403);
    }
    console.error("[delegation/setup] Error:", err);
    return c.json({ error: sanitizeError(err instanceof Error ? err.message : "Internal error") }, 500);
  }
});

/**
 * POST /api/delegation/confirm
 *
 * Called after the operator has signed and broadcast the EIP-7702 authorization.
 * Saves the delegation config so the agent can start executing transactions.
 *
 * Body: { operatorAddress, vaultAddress, chainId, authSignature, authTimestamp, txHash }
 */
delegation.post("/confirm", async (c) => {
  try {
    const body = await c.req.json<{
      operatorAddress: string;
      vaultAddress: string;
      chainId: number;
      authSignature: string;
      authTimestamp: number;
      txHash?: string;
    }>();

    // Auth gate
    await verifyOperatorAuth({
      operatorAddress: body.operatorAddress,
      vaultAddress: body.vaultAddress,
      authSignature: body.authSignature,
      authTimestamp: body.authTimestamp,
      preferredChainId: body.chainId,
      alchemyKey: c.env.ALCHEMY_API_KEY,
    });

    // Get the agent wallet info
    const walletInfo = await getAgentWalletInfo(c.env.KV, body.vaultAddress);
    if (!walletInfo) {
      return c.json({ error: "No agent wallet found. Call /setup first." }, 400);
    }

    const { ALLOWED_VAULT_SELECTORS } = await import("../abi/rigoblockVault.js");
    const allowedSelectors = Object.values(ALLOWED_VAULT_SELECTORS) as Hex[];

    const config = await confirmDelegation(
      c.env,
      body.operatorAddress as Address,
      body.vaultAddress as Address,
      walletInfo.address,
      body.chainId,
      allowedSelectors,
    );

    return c.json({
      delegation: config,
      message: `Delegation confirmed on chain ${body.chainId}. The agent can now execute trades on your vault. Switch to "Delegated" mode in the chat to use it.`,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: err.message }, err.status as 401 | 403);
    }
    console.error("[delegation/confirm] Error:", err);
    return c.json({ error: sanitizeError(err instanceof Error ? err.message : "Internal error") }, 500);
  }
});

/**
 * POST /api/delegation/revoke
 *
 * Disable the agent's ability to execute transactions.
 * Note: The on-chain delegation should also be revoked by the operator separately.
 *
 * Body: { operatorAddress, vaultAddress, authSignature, authTimestamp }
 */
delegation.post("/revoke", async (c) => {
  try {
    const body = await c.req.json<{
      operatorAddress: string;
      vaultAddress: string;
      chainId: number;
      authSignature: string;
      authTimestamp: number;
      deleteWallet?: boolean;
    }>();

    // Auth gate
    await verifyOperatorAuth({
      operatorAddress: body.operatorAddress,
      vaultAddress: body.vaultAddress,
      authSignature: body.authSignature,
      authTimestamp: body.authTimestamp,
      preferredChainId: body.chainId,
      alchemyKey: c.env.ALCHEMY_API_KEY,
    });

    await revokeDelegation(c.env.KV, body.vaultAddress);

    if (body.deleteWallet) {
      await deleteAgentWallet(c.env.KV, body.vaultAddress);
    }

    return c.json({
      message: "Delegation revoked. The agent can no longer execute transactions. Remember to also revoke the on-chain delegation in your wallet settings.",
      walletDeleted: !!body.deleteWallet,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: err.message }, err.status as 401 | 403);
    }
    console.error("[delegation/revoke] Error:", err);
    return c.json({ error: sanitizeError(err instanceof Error ? err.message : "Internal error") }, 500);
  }
});

/**
 * GET /api/delegation/status?vaultAddress=0x…&chainId=42161
 *
 * Check delegation status for a vault (no auth required for reads).
 */
delegation.get("/status", async (c) => {
  const vaultAddress = c.req.query("vaultAddress");
  const chainId = Number(c.req.query("chainId") || "0");

  if (!vaultAddress) {
    return c.json({ error: "vaultAddress query param required" }, 400);
  }

  const config = await getDelegationConfig(c.env.KV, vaultAddress);
  const walletInfo = await getAgentWalletInfo(c.env.KV, vaultAddress);

  return c.json({
    enabled: config?.enabled || false,
    agentAddress: walletInfo?.address || null,
    activeChains: config?.activeChains || [],
    isActiveOnChain: chainId ? config?.activeChains?.includes(chainId) || false : undefined,
    delegatedChains: walletInfo?.delegatedChains || [],
  });
});

/**
 * GET /api/delegation/balance?vaultAddress=0x…&chainId=42161
 *
 * Check if the agent wallet has enough ETH for gas.
 */
delegation.get("/balance", async (c) => {
  const vaultAddress = c.req.query("vaultAddress");
  const chainId = Number(c.req.query("chainId") || "1");

  if (!vaultAddress) {
    return c.json({ error: "vaultAddress query param required" }, 400);
  }

  try {
    const result = await checkAgentBalance(c.env, vaultAddress, chainId);
    return c.json({
      agentAddress: result.address,
      balance: result.balance.toString(),
      balanceEth: Number(result.balance) / 1e18,
      sufficient: result.sufficient,
      chainId,
    });
  } catch (err) {
    if (err instanceof ExecutionError && err.code === "AGENT_WALLET_NOT_FOUND") {
      return c.json({ error: "No agent wallet exists for this vault. Set up delegation first." }, 404);
    }
    console.error("[delegation/balance] Error:", err);
    return c.json({ error: sanitizeError(err instanceof Error ? err.message : "Internal error") }, 500);
  }
});

export { delegation };
