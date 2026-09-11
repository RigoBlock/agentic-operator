/**
 * Transaction preparation — run the safety stack once when the user prompts.
 *
 * Responsibilities:
 *   - Determine the executor (operator EOA or delegated agent wallet).
 *   - Run the NAV shield for vault-targeted transactions.
 *   - Estimate gas units and EIP-1559 fees from the executor address.
 *
 * This function does NOT read on-chain state that the tool handler has already
 * validated (vault owner, contract existence, etc.). It assumes the caller has
 * provided a valid RequestContext with operatorAddress and vaultAddress.
 */

import type { PublicClient, Hex, Address } from "viem";
import type { Env, RequestContext, TransactionDraft, UnsignedTransaction, DelegationConfig } from "../types.js";
import { ZERO_ADDRESS } from "../config.js";
import {
  getChainDelegation,
  getDelegationConfig,
  saveDelegationConfig,
  getAgentDelegatedSelectors,
  getDelegableSelectors,
  selectChainExecutor,
} from "./delegation.js";
import { createAgentWallet, markChainDelegated } from "./agentWallet.js";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { checkNavImpact, getNavShieldThreshold } from "./navGuard.js";
import { getRpcProvider } from "./rpcClient.js";
import { getScaAddress } from "./scaAccount.js";
import { ExecutionError } from "./executionError.js";
import { estimateGasFees, type GasFees } from "./gas.js";
import { getRevertDataFromError, traceRevertReason } from "./errorDecoder.js";

/**
 * Recover the delegated executor from on-chain state when KV has no record for
 * the chain.
 *
 * KV can be empty or stale while on-chain delegation is active (fresh/reset dev
 * KV, or the chain was delegated outside this UI). Downgrading silently to
 * operator signing in that case makes a delegated operator sign every
 * transaction in MetaMask — so verify on-chain first, and heal KV when the
 * delegation is real. The on-chain check is the same one the status route uses.
 */
async function resolveDelegatedExecutorFromChain(
  env: Env,
  vaultAddress: string,
  chainId: number,
): Promise<Address | null> {
  if (!env.KV) return null;
  try {
    const config = await getDelegationConfig(env.KV, vaultAddress);
    if (config && !config.enabled) return null; // operator disabled delegation — respect it

    // Agent address: from KV if present, else the deterministic CDP account
    // (idempotent — the same address the delegation was granted to).
    const agentAddress = config?.agentAddress
      ?? (await createAgentWallet(env.KV, vaultAddress, env)).address;
    if (!agentAddress) return null;

    // HyperEVM (999): the primary delegatee is the sma-b smart-account address.
    // Use the stored one, else derive it fresh (deterministic per agent EOA) —
    // on-chain delegation granted to the agent alone does not cover the
    // sponsored path on 999.
    let scaAddress: string | undefined = config?.chains?.["999"]?.scaAddress;
    if (chainId === 999 && !scaAddress) {
      try {
        const derived = await getScaAddress(agentAddress as Address, env.ALCHEMY_API_KEY);
        if (derived) scaAddress = derived.toLowerCase();
      } catch (scaErr) {
        console.warn(
          `[prepare] Could not derive the HyperEVM sponsored account address: ` +
          `${scaErr instanceof Error ? scaErr.message : String(scaErr)}`,
        );
      }
      if (!scaAddress) return null;
    }
    const delegatee = scaAddress ?? agentAddress;

    // Authority resolution and the vault delegation read are independent —
    // issue them together so viem batches them into a single HTTP round-trip.
    const [delegableSelectors, onChainSelectors] = await Promise.all([
      getDelegableSelectors(chainId),
      getAgentDelegatedSelectors(chainId, vaultAddress as Address, delegatee as Address),
    ]);
    if (!onChainSelectors) return null;
    const onChainSet = new Set<string>(onChainSelectors);
    const delegatedSelectors = delegableSelectors.filter((s) => onChainSet.has(s.toLowerCase()));
    if (delegatedSelectors.length === 0) return null;

    // Heal KV (best-effort) so subsequent prepares and /api/delegation/execute
    // take the fast path and the UI sees the chain as delegated.
    try {
      const operatorAddress = config?.operatorAddress
        ?? (await getRpcProvider(chainId).readContract({
          address: vaultAddress as Address,
          abi: RIGOBLOCK_VAULT_ABI,
          functionName: "getPool",
        }) as { owner: Address }).owner;
      const healed: DelegationConfig = {
        enabled: true,
        agentAddress,
        operatorAddress,
        vaultAddress: vaultAddress as Address,
        sponsoredGas: config?.sponsoredGas ?? true,
        chains: {
          ...(config?.chains ?? {}),
          [String(chainId)]: {
            confirmedAt: Date.now(),
            delegatedSelectors: delegatedSelectors,
            ...(chainId === 999 && scaAddress ? { scaAddress } : {}),
          },
        },
      };
      await saveDelegationConfig(env.KV, healed);
      await markChainDelegated(env.KV, vaultAddress, chainId);
    } catch (healErr) {
      console.warn("[prepare] Delegation KV heal failed (non-fatal):", healErr);
    }
    // On HyperEVM with sponsored gas effectively ON, the healed executor is the
    // sma-b account (sponsored primary); otherwise the agent EOA (fallback).
    const healedSponsored = config?.sponsoredGas ?? true;
    if (chainId === 999 && scaAddress && healedSponsored) return scaAddress as Address;
    return agentAddress;
  } catch {
    return null;
  }
}

/**
 * Prepare a transaction for signing/broadcast.
 *
 * The returned `UnsignedTransaction` includes the executor (`from`), gas limit,
 * EIP-1559 fees, and the NAV-shield marker. The caller stores this exact object
 * server-side and replays it at execution time without re-estimating or
 * re-simulating.
 */
export async function prepareTransaction(
  env: Env,
  ctx: Pick<RequestContext, "vaultAddress" | "chainId" | "operatorAddress" | "operatorVerified" | "executionMode">,
  draft: TransactionDraft,
): Promise<{ tx: UnsignedTransaction; warning?: string }> {
  // Determine the executor (sender) before constructing the full transaction so
  // the `from` field is present from the start.
  //
  // Delegated mode is honored ONLY when delegation is active on the transaction's
  // chain (draft.chainId). The UI's active chain can differ from the chain a tool
  // actually targets (e.g. Hyperliquid tools run on HyperEVM while the UI shows
  // Ethereum) — falling back to the operator signer in that case keeps the
  // operator-signer default the user expects.
  let executor: Address;
  if (draft.operatorOnly || ctx.executionMode === "manual") {
    if (!ctx.operatorAddress) {
      throw new ExecutionError(
        "Operator address is required to prepare this transaction.",
        "OPERATOR_ADDRESS_REQUIRED",
      );
    }
    executor = ctx.operatorAddress;
  } else {
    if (!ctx.vaultAddress || ctx.vaultAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new ExecutionError(
        "Vault address is required to prepare a delegated transaction.",
        "VAULT_ADDRESS_REQUIRED",
      );
    }
    const chainDelegation = env.KV
      ? await getChainDelegation(env.KV, ctx.vaultAddress, draft.chainId)
      : null;
    if (chainDelegation) {
      const config = await getDelegationConfig(env.KV!, ctx.vaultAddress);
      if (!config || !config.enabled) {
        throw new ExecutionError(
          "Delegation not configured. Set up delegation on the vault first.",
          "DELEGATION_NOT_CONFIGURED",
        );
      }
      // On HyperEVM (999), sponsored gas ON + a stored sma-b account means the
      // sca address is the sender; otherwise the agent EOA broadcasts directly.
      //
      // Sponsored ON without a stored sca is a hard error, not a silent downgrade:
      // preparing an agent-EOA tx while the UI shows sponsored gas enabled would
      // surface a confusing direct-path balance failure at execution time. The
      // one-time fix is the HyperEVM delegation Update (Settings → Delegation).
      if (draft.chainId === 999 && !chainDelegation.scaAddress) {
        const sponsoredEffectiveOn999 = chainDelegation.sponsoredGas !== undefined
          ? chainDelegation.sponsoredGas
          : (config.sponsoredGas ?? true);
        if (sponsoredEffectiveOn999) {
          throw new ExecutionError(
            "Sponsored gas is enabled on HyperEVM, but the sponsored agent account is not set up for this vault yet. " +
            "Open Settings → Delegation and run 'Update' for HyperEVM once (one on-chain transaction), " +
            "or turn off 'Sponsored gas (HyperEVM)' to execute with the agent wallet paying gas.",
            "PREPARATION_FAILED",
          );
        }
      }
      executor = selectChainExecutor(chainDelegation, config, draft.chainId);
    } else {
      // KV has no record for this chain — check on-chain before downgrading.
      // A delegated operator must never get a silent MetaMask popup because
      // KV was empty or stale.
      const healedExecutor = await resolveDelegatedExecutorFromChain(
        env, ctx.vaultAddress, draft.chainId,
      );
      if (healedExecutor) {
        executor = healedExecutor;
      } else if (!ctx.operatorAddress) {
        // Delegation not active on the target chain — operator signs instead.
        throw new ExecutionError(
          `Delegated mode requested but delegation is not active on chain ${draft.chainId}, ` +
          "and no operator address is available to sign manually.",
          "DELEGATION_NOT_ACTIVE_ON_CHAIN",
        );
      } else {
        executor = ctx.operatorAddress;
      }
    }
  }

  const tx: UnsignedTransaction = {
    ...draft,
    from: executor,
    gas: "0x0",
    maxFeePerGas: "0x0",
    maxPriorityFeePerGas: "0x0",
    navShieldChecked: false,
  };
  const publicClient = getRpcProvider(tx.chainId);
  const txValue = BigInt(tx.value || "0x0");

  // NAV shield only applies when the transaction targets the vault itself.
  const isVaultTarget = !!ctx.vaultAddress &&
    ctx.vaultAddress.toLowerCase() !== ZERO_ADDRESS.toLowerCase() &&
    tx.to.toLowerCase() === ctx.vaultAddress.toLowerCase();

  if (isVaultTarget) {
    const storedNavThreshold = env.KV && ctx.operatorAddress
      ? await getNavShieldThreshold(env.KV, ctx.operatorAddress)
      : null;

    const navResult = await checkNavImpact(
      ctx.vaultAddress as Address,
      tx.data,
      txValue,
      tx.chainId,
      // The authenticated operator IS the vault owner (verifyOperatorAuth), so
      // pass it and skip the on-chain owner read on this latency-critical path.
      ctx.operatorVerified && ctx.operatorAddress
        ? (ctx.operatorAddress as Address)
        : undefined,
      env.KV,
      storedNavThreshold ?? undefined,
    );

    if (!navResult.allowed) {
      if (navResult.code === "TRADE_REVERTS") {
        const warning = `⚠️ Simulation warning: ${navResult.reason || "the transaction would revert on-chain"}`;
        tx.revertWarning = warning;
        tx.navShieldChecked = true;
        return { tx, warning };
      }
      throw new ExecutionError(
        navResult.reason || "Trade blocked by NAV protection — would reduce unit price too much",
        "NAV_SHIELD_BLOCKED",
      );
    }

    tx.navShieldChecked = true;
  }

  // Estimate gas units and EIP-1559 fees directly from the executor. A revert here
  // is a trade-level failure and is surfaced directly so the tool handler can
  // translate it for the user.
  let gasEstimate: bigint;
  let fees: GasFees;
  try {
    [gasEstimate, fees] = await Promise.all([
      publicClient.estimateGas({ account: executor, to: tx.to, data: tx.data, value: txValue }),
      estimateGasFees(publicClient, tx.chainId),
    ]);
  } catch (err) {
    let msg = err instanceof Error ? err.message : String(err);
    const revertData = getRevertDataFromError(err);
    // When the RPC omits revert data (common on HyperEVM), trace the call to
    // recover the on-chain revert reason so the user gets an actionable error.
    if (!revertData) {
      const reason = await traceRevertReason(tx.chainId, {
        from: executor,
        to: tx.to,
        data: tx.data,
        value: txValue,
      });
      if (reason) msg = `${msg} — revert reason: ${reason}`;
    }
    // A bare revert from a delegated executor almost always means the agent wallet
    // is not authorized for this selector on this vault/chain — the vault's
    // authorization check reverts without reason data, so decoding finds nothing.
    const isDelegatedExecutor =
      ctx.executionMode !== "manual" &&
      !!ctx.operatorAddress &&
      executor.toLowerCase() !== ctx.operatorAddress.toLowerCase();
    if (isDelegatedExecutor && !revertData && !msg.includes("revert reason:")) {
      msg += " — the agent wallet may not be authorized for this function on this chain. " +
        "Check delegation status for this selector, or switch to manual mode and sign with your wallet.";
    }
    throw new ExecutionError(
      `Transaction preparation failed: ${msg}`,
      "PREPARATION_FAILED",
    );
  }

  tx.gas = `0x${(gasEstimate + (gasEstimate * 25n) / 100n).toString(16)}`;
  tx.maxFeePerGas = `0x${fees.maxFeePerGas.toString(16)}` as Hex;
  tx.maxPriorityFeePerGas = `0x${fees.maxPriorityFeePerGas.toString(16)}` as Hex;

  // Non-vault transactions are not subject to the NAV shield.
  if (!isVaultTarget) {
    tx.navShieldChecked = true;
  }

  return { tx };
}
