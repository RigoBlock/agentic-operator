/**
 * Delegation routes — POST /api/delegation/*
 *
 * API endpoints for managing vault-based delegation between the pool operator
 * and the agent wallet.
 *
 * The operator delegates specific vault function selectors to the agent by
 * calling vault.updateDelegation(delegations) on-chain.
 *
 * Routes:
 *   POST /api/delegation/setup    → Prepare delegation (returns unsigned delegate() tx)
 *   POST /api/delegation/confirm  → Confirm delegation tx was sent on-chain
 *   POST /api/delegation/revoke   → Prepare revocation (returns unsigned revoke tx + clears KV)
 *   GET  /api/delegation/status   → Check delegation status (KV + on-chain)
 *   GET  /api/delegation/balance  → Check agent wallet ETH balance
 */

import { Hono } from "hono";
import type { Env, UnsignedTransaction } from "../types.js";
import { verifyOperatorAuth, AuthError } from "../services/auth.js";
import {
  prepareDelegation,
  confirmDelegation,
  revokeDelegation,
  revokeDelegationOnChain,
  getDelegationConfig,
  saveDelegationConfig,
  getActiveChains,
  buildDefaultSelectors,
  checkDelegationOnChain,
  isDelegationActive,
  prepareRevocation,
  prepareSelectiveRevocation,
} from "../services/delegation.js";
import { getAgentWalletInfo, deleteAgentWallet } from "../services/agentWallet.js";
import { checkAgentBalance, checkPendingTxStatus, executeViaDelegation, ExecutionError } from "../services/execution.js";
import { sanitizeError } from "../config.js";
import type { Address, Hex } from "viem";

const delegation = new Hono<{ Bindings: Env }>();

/**
 * POST /api/delegation/setup
 *
 * Create agent wallet (if needed) and return an unsigned updateDelegation() tx
 * for the operator to sign and send from their wallet.
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
      transaction: result.transaction,
      selectors: result.selectors,
      message: `Agent wallet ${result.agentAddress} ready. Send the delegation transaction to your vault to grant the agent permission to execute trades.`,
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
 * Called after the operator sends the updateDelegation() tx.
 * Records the delegation state in KV so the agent can start executing.
 *
 * Body: { operatorAddress, vaultAddress, chainId, authSignature, authTimestamp,
 *         txHash, selectors? }
 */
delegation.post("/confirm", async (c) => {
  try {
    const body = await c.req.json<{
      operatorAddress: string;
      vaultAddress: string;
      chainId: number;
      authSignature: string;
      authTimestamp: number;
      txHash: string;
      selectors?: string[];
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

    if (!body.txHash) {
      return c.json({ error: "txHash is required." }, 400);
    }

    // Get the agent wallet info
    const walletInfo = await getAgentWalletInfo(c.env.KV, body.vaultAddress);
    if (!walletInfo) {
      return c.json({ error: "No agent wallet found. Call /setup first." }, 400);
    }

    const selectors = (body.selectors?.map((s) => s as Hex)) || buildDefaultSelectors();

    const config = await confirmDelegation(
      c.env,
      body.operatorAddress as Address,
      body.vaultAddress as Address,
      walletInfo.address,
      body.chainId,
      selectors,
      body.txHash as Hex,
    );

    return c.json({
      delegation: config,
      activeChains: getActiveChains(config),
      message: `Delegation confirmed on chain ${body.chainId}. The agent can now execute trades on your vault.`,
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
 * Prepare an on-chain revocation and clear KV delegation state.
 * Returns an unsigned vault.revokeAllDelegations() tx for the operator to send.
 *
 * Body: { operatorAddress, vaultAddress, chainId?, authSignature, authTimestamp, deleteWallet? }
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

    // Prepare on-chain revocation tx (calls vault.revokeAllDelegations(agentAddress))
    const revocation = await prepareRevocation(
      c.env,
      body.vaultAddress as Address,
      body.chainId,
    );

    // Clear KV delegation state
    if (body.chainId && !body.deleteWallet) {
      await revokeDelegationOnChain(c.env.KV, body.vaultAddress, body.chainId);
    } else {
      await revokeDelegation(c.env.KV, body.vaultAddress);
    }

    if (body.deleteWallet) {
      await deleteAgentWallet(c.env.KV, body.vaultAddress);
    }

    return c.json({
      transaction: revocation.transaction,
      message: body.chainId && !body.deleteWallet
        ? `Delegation revoked on chain ${body.chainId}. Send the revocation transaction to remove the on-chain delegation.`
        : "Delegation revoked on all chains. Send the revocation transaction(s) to remove the on-chain delegation.",
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
 * GET /api/delegation/status?vaultAddress=0x…&chainId=42161&verify=true
 *
 * Check delegation status for a vault.
 * If verify=true, also checks on-chain via getDelegatedSelectors.
 */
delegation.get("/status", async (c) => {
  const vaultAddress = c.req.query("vaultAddress");
  const chainId = Number(c.req.query("chainId") || "0");
  const verifyOnChain = c.req.query("verify") === "true";

  if (!vaultAddress) {
    return c.json({ error: "vaultAddress query param required" }, 400);
  }

  const config = await getDelegationConfig(c.env.KV, vaultAddress);
  const walletInfo = await getAgentWalletInfo(c.env.KV, vaultAddress);
  const activeChains = config ? getActiveChains(config) : [];
  const chainDelegation = chainId ? config?.chains?.[String(chainId)] : undefined;

  // Optional on-chain verification
  let onChainStatus = null;
  if (verifyOnChain && walletInfo?.address && chainId && vaultAddress) {
    try {
      const selectors = buildDefaultSelectors();
      onChainStatus = await checkDelegationOnChain(
        chainId,
        vaultAddress as Address,
        walletInfo.address,
        selectors,
        c.env.ALCHEMY_API_KEY,
      );
    } catch (err) {
      console.warn("[delegation/status] On-chain check failed:", err);
    }
  }

  return c.json({
    enabled: config?.enabled || false,
    agentAddress: walletInfo?.address || null,
    activeChains,
    sponsoredGas: config?.sponsoredGas ?? true,
    isActiveOnChain: verifyOnChain ? (onChainStatus?.allDelegated || false) : undefined,
    isActiveInKV: chainId ? activeChains.includes(chainId) : undefined,
    delegatedChains: walletInfo?.delegatedChains || [],
    onChainStatus,
    chainDelegation: chainDelegation
      ? {
          confirmedAt: chainDelegation.confirmedAt,
          delegatedSelectors: chainDelegation.delegatedSelectors,
          delegateTxHash: chainDelegation.delegateTxHash,
        }
      : null,
  });
});

/**
 * POST /api/delegation/execute
 *
 * Directly execute a pre-built unsigned transaction via the agent wallet.
 * Skips LLM processing entirely — used when the operator has already reviewed
 * and approved the transaction details, so we just broadcast immediately.
 *
 * This is the fast path: simulate → broadcast → wait for receipt.
 * No LLM API calls, no DEX API re-fetches.
 *
 * Body: { operatorAddress, vaultAddress, chainId, authSignature, authTimestamp, transaction }
 */
delegation.post("/execute", async (c) => {
  try {
    const body = await c.req.json<{
      operatorAddress: string;
      vaultAddress: string;
      chainId: number;
      authSignature: string;
      authTimestamp: number;
      transaction: {
        to: string;
        data: string;
        value: string;
        chainId: number;
        gas?: string;
        description?: string;
      };
    }>();

    if (!body.transaction?.to || !body.transaction?.data) {
      return c.json({ error: "transaction.to and transaction.data are required" }, 400);
    }

    // Auth gate
    await verifyOperatorAuth({
      operatorAddress: body.operatorAddress,
      vaultAddress: body.vaultAddress,
      authSignature: body.authSignature,
      authTimestamp: body.authTimestamp,
      preferredChainId: body.chainId,
      alchemyKey: c.env.ALCHEMY_API_KEY,
    });

    // Verify delegation is active on this chain
    const active = await isDelegationActive(c.env.KV, body.vaultAddress, body.chainId);
    if (!active) {
      // Return fallback signal so the frontend can switch to manual wallet signing
      return c.json({
        error: `Delegation not active on chain ${body.chainId}. You can sign this transaction directly from your wallet.`,
        code: "DELEGATION_NOT_ON_CHAIN",
        fallbackToManual: true,
        transaction: body.transaction,
      }, 400);
    }

    const tx: UnsignedTransaction = {
      to: body.transaction.to as Address,
      data: body.transaction.data as Hex,
      value: body.transaction.value || "0x0",
      chainId: body.transaction.chainId || body.chainId,
      gas: body.transaction.gas || "0x0",
      description: body.transaction.description || "",
    };

    console.log(`[delegation/execute] Executing tx: to=${tx.to} chainId=${tx.chainId} selector=${tx.data.slice(0,10)} vault=${body.vaultAddress}`);
    const result = await executeViaDelegation(c.env, tx, body.vaultAddress);
    console.log(`[delegation/execute] Success: txHash=${result.txHash} confirmed=${result.confirmed}`);
    return c.json({ executionResult: result });
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: err.message }, err.status as 401 | 403);
    }
    if (err instanceof ExecutionError) {
      console.error(`[delegation/execute] ExecutionError: code=${err.code} msg=${err.message}`);
      return c.json({ error: sanitizeError(err.message), code: err.code }, 400);
    }
    // Log the FULL error for debugging — the sanitized version hides crucial details
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    console.error(`[delegation/execute] UNHANDLED ERROR: ${errMsg}`);
    if (errStack) console.error(`[delegation/execute] Stack: ${errStack}`);
    return c.json({ error: sanitizeError(errMsg) }, 500);
  }
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

/**
 * GET /api/delegation/tx-status?hash=0x…&chainId=8453
 *
 * Check the status of a pending agent transaction.
 */
delegation.get("/tx-status", async (c) => {
  const hash = c.req.query("hash");
  const chainId = Number(c.req.query("chainId") || "1");

  if (!hash) {
    return c.json({ error: "hash query param required" }, 400);
  }

  try {
    const result = await checkPendingTxStatus(c.env, hash, chainId);

    if (!result) {
      return c.json({ status: "pending", hash, chainId });
    }

    return c.json({
      status: result.confirmed ? "confirmed" : "failed",
      ...result,
    });
  } catch (err) {
    console.error("[delegation/tx-status] Error:", err);
    return c.json({ error: sanitizeError(err instanceof Error ? err.message : "Internal error") }, 500);
  }
});

/**
 * POST /api/delegation/settings
 *
 * Update delegation settings (e.g. sponsoredGas toggle).
 *
 * Body: { operatorAddress, vaultAddress, sponsoredGas, authSignature, authTimestamp }
 */
delegation.post("/settings", async (c) => {
  try {
    const body = await c.req.json<{
      operatorAddress: string;
      vaultAddress: string;
      sponsoredGas?: boolean;
      authSignature: string;
      authTimestamp: number;
    }>();

    await verifyOperatorAuth({
      operatorAddress: body.operatorAddress,
      vaultAddress: body.vaultAddress,
      authSignature: body.authSignature,
      authTimestamp: body.authTimestamp,
      preferredChainId: 1, // Auth is chain-independent
      alchemyKey: c.env.ALCHEMY_API_KEY,
    });

    const config = await getDelegationConfig(c.env.KV, body.vaultAddress);
    if (!config) {
      return c.json({ error: "No delegation config found. Set up delegation first." }, 404);
    }

    if (body.sponsoredGas !== undefined) {
      config.sponsoredGas = body.sponsoredGas;
    }

    await saveDelegationConfig(c.env.KV, config);

    return c.json({ ok: true, sponsoredGas: config.sponsoredGas });
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: err.message }, err.status as 401 | 403);
    }
    console.error("[delegation/settings] Error:", err);
    return c.json({ error: sanitizeError(err instanceof Error ? err.message : "Internal error") }, 500);
  }
});

export { delegation };
