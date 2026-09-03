/**
 * Execution Service — broadcast pre-prepared transactions from the agent wallet.
 *
 * This module only broadcasts. All validation, simulation, NAV shield, and gas
 * estimation happens once during prepareTransaction() before the user confirms.
 * On execution we only:
 *   - load the delegated agent wallet,
 *   - verify tx.from matches the loaded signer,
 *   - broadcast via direct EIP-1559 tx or Alchemy-sponsored UserOp,
 *   - wait for the receipt.
 */

import {
  createWalletClient,
  http,
  formatGwei,
  formatEther,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import type { LocalAccount } from "viem/accounts";
import type { Env, UnsignedTransaction, TransactionDraft, ExecutionResult } from "../types.js";
import { getChain, getRpcUrl, sanitizeError, MIN_BALANCE, EXPLORER_TX_URL } from "../config.js";
import { loadAgentWalletAccount } from "./agentWallet.js";
import { getDelegationConfig, getChainDelegation } from "./delegation.js";
import { recordGasSpend } from "../routes/gasPolicy.js";
import {
  executeSponsoredCalls,
  getSponsoredCallsStatus,
  type WalletCall,
} from "./bundler.js";
import { getRpcProvider, ALCHEMY_ORIGIN } from "./rpcClient.js";
import {
  bumpGasFees,
  getTransactionFees,
  RESUBMIT_FEE_BUMP_PCT,
  type GasFees,
} from "./gas.js";
import { ExecutionError } from "./executionError.js";

// ── Gas Safety Configuration ──────────────────────────────────────────

/** Maximum number of resubmission attempts */
const MAX_RESUBMIT_ATTEMPTS = 2;

/** Timeout for waiting for a tx receipt (ms) */
const TX_CONFIRM_TIMEOUT_MS = 60_000;

/** Fast-confirming chains (L2s, BSC, HyperEVM) with sub-second block times */
const FAST_CHAIN_IDS = new Set([10, 42161, 8453, 130, 56, 999, 84532]);

/**
 * Execute a pre-prepared transaction via the agent wallet.
 *
 * This is the ONLY public function that broadcasts transactions from the agent
 * wallet. ALL delegated transactions go through here.
 *
 * The caller (prepareTransaction) has already run the full safety stack:
 * delegation check, NAV shield, gas estimation, and EIP-1559 fee estimation.
 * This function trusts the stored transaction and only confirms the sender can
 * broadcast it. It does NOT re-simulate or re-validate target/selector/state.
 */
export async function executeViaDelegation(
  env: Env,
  tx: UnsignedTransaction,
  vaultAddress: string,
  sponsoredGasOverride?: boolean,
  _requestCache?: Map<string, Promise<{ unitaryValue: bigint; totalValue: bigint; timestamp: bigint }>>,
): Promise<ExecutionResult> {
  // Load delegation config to resolve sponsorship preference and the expected agent.
  const config = await getDelegationConfig(env.KV, vaultAddress);
  if (!config || !config.enabled) {
    throw new ExecutionError(
      "Delegation not configured. Set up delegation on the vault first.",
      "DELEGATION_NOT_CONFIGURED",
    );
  }

  // Load the agent wallet that will sign the broadcast.
  let agentAccount: LocalAccount;
  try {
    const loaded = await loadAgentWalletAccount(env.KV, vaultAddress, env);
    if (!loaded) {
      throw new ExecutionError(
        "Agent wallet not found for this vault",
        "AGENT_WALLET_NOT_FOUND",
      );
    }
    agentAccount = loaded;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof ExecutionError) throw err;
    throw new ExecutionError(
      `Agent wallet unavailable: ${sanitizeError(msg)}. ` +
      `The CDP service may be temporarily unreachable. Sign this transaction directly from your wallet.`,
      "AGENT_WALLET_ERROR",
      true,
    );
  }

  // The stored transaction already encodes who must send it. Verify the loaded
  // signer matches. This is the only execution-time identity check: whoever
  // broadcasts must be the address in `tx.from`. For delegated mode that is the
  // agent wallet; a future manual-execution path would load the operator EOA
  // and apply the same check.
  if (agentAccount.address.toLowerCase() !== tx.from.toLowerCase()) {
    throw new ExecutionError(
      "Stored transaction sender does not match the wallet that will broadcast it.",
      "SENDER_MISMATCH",
    );
  }

  // Choose execution path: sponsored (ERC-4337 bundler) or direct broadcast.
  const chainDelegation = await getChainDelegation(env.KV, vaultAddress, tx.chainId);
  const chainSponsored = chainDelegation?.sponsoredGas !== undefined
    ? chainDelegation.sponsoredGas
    : config.sponsoredGas;
  const effectiveSponsored = sponsoredGasOverride !== undefined ? sponsoredGasOverride : chainSponsored;
  const useSponsored = effectiveSponsored && !!env.ALCHEMY_GAS_POLICY_ID;

  let result: ExecutionResult;

  if (useSponsored) {
    // Sponsored path: Alchemy paymaster covers gas. Falls back to direct broadcast
    // if sponsorship fails for any non-simulation reason.
    result = await sponsoredAgentTransaction(
      agentAccount,
      tx,
      tx.chainId,
      env.ALCHEMY_GAS_POLICY_ID!,
      env.KV,
    );
  } else {
    // Direct broadcast: agent wallet pays gas.
    result = await broadcastAgentTransaction(
      agentAccount,
      tx,
      tx.chainId,
    );
  }

  // Store pending tx in KV for async monitoring (if not yet confirmed)
  if (!result.confirmed) {
    await storePendingTx(env.KV, vaultAddress, result);
  }

  return result;
}

/**
 * Broadcast a transaction from the agent wallet directly to the vault.
 *
 * Gas and EIP-1559 fee values are pre-computed by prepareTransaction() and
 * reused here. This function checks balance, broadcasts, and waits for
 * confirmation with automatic resubmission.
 *
 * Steps:
 *   1. Check agent balance
 *   2. Reuse pre-computed gas limit (tx.gas) and fee values
 *   3. Send the transaction
 *   4. Wait for confirmation with automatic resubmission
 */
async function broadcastAgentTransaction(
  agentAccount: LocalAccount,
  tx: UnsignedTransaction,
  chainId: number,
): Promise<ExecutionResult> {
  try {
  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId);

  const publicClient = getRpcProvider(chainId);
  const txValue = BigInt(tx.value);

  // ── Step 1: Parallelize independent pre-broadcast reads ──
  // Balance and nonce are independent; the fee estimate is already attached
  // by prepareTransaction() so the same EIP-1559 values are used for display
  // and broadcast. If it is missing the transaction was not finalized.
  const [balance, nonce] = await Promise.all([
    publicClient.getBalance({ address: agentAccount.address }),
    publicClient.getTransactionCount({ address: agentAccount.address }),
  ]);

  let fees = getTransactionFees(tx, chainId);

  if (txValue > 0n && balance < txValue) {
    throw new ExecutionError(
      `Agent balance (${(Number(balance) / 1e18).toFixed(6)} ETH) insufficient for tx value ` +
      `(${(Number(txValue) / 1e18).toFixed(6)} ETH). Fund the agent at ${agentAccount.address}`,
      "INSUFFICIENT_BALANCE",
    );
  }

  // ── Step 2: Use pre-computed gas limit ──
  // Gas was already estimated once by prepareTransaction() from the agent address
  // and includes a 25% buffer. We reuse it here to avoid a duplicate eth_estimateGas
  // on the broadcast hot path.
  const gasLimit = BigInt(tx.gas);

  const estimatedCost = (gasLimit * fees.maxFeePerGas) + txValue;
  if (balance < estimatedCost) {
    const needed = Number(estimatedCost) / 1e18;
    const have = Number(balance) / 1e18;
    // Use enough decimal places to show non-zero L2 gas costs (~0.0000003 ETH)
    const fmt = (n: number) => n < 0.000001 ? n.toExponential(2) : n.toFixed(8);
    throw new ExecutionError(
      `Agent balance too low for this transaction. ` +
      `Have: ${fmt(have)} ETH, need: ~${fmt(needed)} ETH ` +
      `(gas: ${gasLimit} × ${formatGwei(fees.maxFeePerGas)} gwei). ` +
      `Send ${fmt(needed - have)} ETH to ${agentAccount.address}`,
      "INSUFFICIENT_BALANCE",
    );
  }

  // ── Step 4: Send the transaction ──
  const walletClient = createWalletClient({
    account: agentAccount,
    chain,
    transport: http(rpcUrl, rpcUrl?.includes("alchemy.com")
      ? { fetchOptions: { headers: { Origin: ALCHEMY_ORIGIN } } }
      : undefined,
    ),
  });

  let txHash = await walletClient.sendTransaction({
    to: tx.to as Address,
    data: tx.data as Hex,
    value: txValue,
    gas: gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    nonce,
  });


  // ── Step 5: Wait for confirmation with resubmission ──
  let receipt: TransactionReceipt | null = null;
  let attempt = 0;

  while (attempt <= MAX_RESUBMIT_ATTEMPTS) {
    try {
      receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: FAST_CHAIN_IDS.has(chainId) ? 10_000 : TX_CONFIRM_TIMEOUT_MS,
        pollingInterval: FAST_CHAIN_IDS.has(chainId) ? 500 : 2_000,
      });
      break;
    } catch (err) {
      const errMsg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (!errMsg.includes("timed out") && !errMsg.includes("timeout")) {
        throw err;
      }

      attempt++;
      if (attempt > MAX_RESUBMIT_ATTEMPTS) {
        break;
      }

      // Check if the original tx was actually included while we waited
      try {
        const currentReceipt = await publicClient.getTransactionReceipt({ hash: txHash });
        if (currentReceipt) {
          receipt = currentReceipt;
          break;
        }
      } catch {
        // Not mined yet — proceed with resubmission
      }

      // Bump fees and resubmit with same nonce
      fees = bumpGasFees(fees, chainId);


      try {
        txHash = await walletClient.sendTransaction({
          to: tx.to as Address,
          data: tx.data as Hex,
          value: txValue,
          gas: gasLimit,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          nonce,
        });
      } catch (resubmitErr) {
        break;
      }
    }
  }

  // Final check: the last wait may have timed out right before the tx landed.
  if (!receipt) {
    try {
      const finalReceipt = await publicClient.getTransactionReceipt({ hash: txHash });
      if (finalReceipt) {
        receipt = finalReceipt;
      }
    } catch {
      // Still not on-chain
    }
  }

  const explorerBase = EXPLORER_TX_URL[chainId];
  const explorerUrl = explorerBase ? `${explorerBase}${txHash}` : undefined;

  // ── Build result with gas receipt details ──
  let gasUsed: string | undefined;
  let effectiveGasPrice: string | undefined;
  let gasCostEth: string | undefined;

  if (receipt) {
    gasUsed = receipt.gasUsed.toString();
    effectiveGasPrice = receipt.effectiveGasPrice.toString();
    const cost = receipt.gasUsed * receipt.effectiveGasPrice;
    gasCostEth = formatEther(cost);
  }

  return {
    txHash,
    chainId,
    confirmed: receipt?.status === "success",
    reverted: receipt != null && receipt.status !== "success",
    blockNumber: receipt ? Number(receipt.blockNumber) : undefined,
    explorerUrl,
    gasUsed,
    effectiveGasPrice,
    gasCostEth,
    sponsored: false,
    resubmitAttempts: attempt,
  };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof ExecutionError) throw err;
    throw new ExecutionError(
      `Broadcast failed: ${sanitizeError(msg)}`,
      "EXECUTION_FAILED",
    );
  }
}

// ── Sponsored Execution via Alchemy Smart Wallet SDK ─────────────────

/**
 * Execute a transaction via Alchemy Smart Wallet with gas sponsoring.
 *
 * Uses @account-kit/wallet-client's createSmartWalletClient + sendCalls.
 * The SDK handles EVERYTHING internally:
 *   - wallet_requestAccount (maps signer → SCA)
 *   - wallet_prepareCalls (builds UserOp, detects 7702 delegation)
 *   - Signing (7702 auth + UserOp)
 *   - wallet_sendPreparedCalls (submits bundle)
 *   - wallet_getCallsStatus (polls until confirmed)
 *
 * We only:
 *   1. Estimate gas on-chain via eth_estimateGas (catches reverts before submission)
 *   2. Call executeSponsoredCalls() — one function, handles everything
 *   3. Map the result to ExecutionResult
 */
async function sponsoredAgentTransaction(
  agentAccount: LocalAccount,
  tx: UnsignedTransaction,
  chainId: number,
  gasPolicyId: string,
  _kv: KVNamespace,
): Promise<ExecutionResult> {
  // The simulation only needs any working RPC — the actual sponsored execution
  // uses the Alchemy SDK's own transport (which supports more chains).
  const publicClient = getRpcProvider(chainId);
  const txValue = BigInt(tx.value);

  // Gas and fees were already estimated by prepareTransaction() with our caps.
  // We pass them through so the sponsored path uses the same bounds as direct
  // broadcast. If Alchemy rejects the fee parameters (e.g. they became stale while
  // the user was reviewing), we retry once without fee overrides so Alchemy can
  // estimate fresh UserOp fees — but only as a fallback, never as the default.
  const callGasLimit = BigInt(tx.gas);
  const fees = getTransactionFees(tx, chainId);

  const calls: WalletCall[] = [{
    to: tx.to as Address,
    value: txValue > 0n ? (`0x${txValue.toString(16)}` as Hex) : ("0x0" as Hex),
    data: tx.data as Hex,
  }];

  let result: Awaited<ReturnType<typeof executeSponsoredCalls>>;
  try {
    result = await executeSponsoredCalls(
      agentAccount,
      chainId,
      gasPolicyId,
      calls,
      callGasLimit,
      fees.maxFeePerGas,
      fees.maxPriorityFeePerGas,
    );
  } catch (firstErr) {
    const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    const isFeeRejection = /invalid parameters|fee too low|underpriced|max fee per gas/i.test(firstMsg);
    if (!isFeeRejection) throw firstErr;

    console.warn(
      `[execution] Sponsored call rejected with stored fees (${formatGwei(fees.maxFeePerGas)} / ${formatGwei(fees.maxPriorityFeePerGas)} gwei), retrying without fee overrides: ${sanitizeError(firstMsg)}`,
    );
    result = await executeSponsoredCalls(
      agentAccount,
      chainId,
      gasPolicyId,
      calls,
      callGasLimit,
    );
  }

  // ── Step 2: Record actual gas spend if we have a receipt ──
  // The paymaster covered the cost, but we still track it against the operator's
  // daily sponsorship stipend so /stipend stays in sync with Alchemy.
  const receipt = result.receipts?.[0];
  if (receipt) {
    const gasUsed = receipt.gasUsed;
    let effectiveGasPrice = (receipt as any).effectiveGasPrice as bigint | undefined;
    if (!effectiveGasPrice && receipt.transactionHash) {
      try {
        const onChainReceipt = await publicClient.getTransactionReceipt({
          hash: receipt.transactionHash,
        });
        effectiveGasPrice = onChainReceipt.effectiveGasPrice;
      } catch (fetchErr) {
        console.warn(
          `[execution] Could not fetch on-chain receipt for gas spend: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
        );
      }
    }
    if (effectiveGasPrice) {
      const gasCostWei = gasUsed * effectiveGasPrice;
      await recordGasSpend(_kv, agentAccount.address, chainId, gasCostWei).catch((err) =>
        console.warn(`[execution] Failed to record sponsored gas spend: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  // ── Map result to ExecutionResult ──
  const explorerBase = EXPLORER_TX_URL[chainId];

  if (result.status === "success" && receipt) {
    const gasUsed = receipt.gasUsed.toString();
    const isSuccess = receipt.status === "success";
    const explorerUrl = explorerBase ? `${explorerBase}${receipt.transactionHash}` : undefined;

    return {
      txHash: receipt.transactionHash,
      chainId,
      confirmed: isSuccess,
      reverted: !isSuccess,
      blockNumber: receipt.blockNumber ? Number(receipt.blockNumber) : undefined,
      explorerUrl,
      gasUsed,
      gasCostEth: "0 (sponsored)",
      sponsored: true,
      resubmitAttempts: 0,
    };
  }

  if (result.status === "failure") {
    const failReceipt = result.receipts?.[0];
    const failTxHash = failReceipt?.transactionHash;
    const failExplorer = explorerBase && failTxHash ? `${explorerBase}${failTxHash}` : undefined;
    const failDetail = failTxHash
      ? ` Tx hash: ${failTxHash}.${failExplorer ? ` Explorer: ${failExplorer}` : ""}`
      : " No receipt returned by bundler.";
    throw new ExecutionError(
      `Sponsored execution failed — the bundler or paymaster rejected the transaction.${failDetail}`,
      "SPONSORED_FAILED",
    );
  }

  // Pending / status timeout — submission was accepted but we could not confirm
  // the on-chain status in time. Do NOT expose the UserOp hash as a transaction
  // hash to the user; it is only a bundler identifier. The frontend/formatter
  // shows "submitted, waiting for on-chain hash" and polls via callId.
  return {
    chainId,
    confirmed: false,
    reverted: false,
    explorerUrl: undefined,
    sponsored: true,
    callId: result.callId as Hex,
    gasCostEth: "0 (sponsored — status check timed out)",
    resubmitAttempts: 0,
  };
}

/**
 * Revoke the EIP-7702 authorization for the agent wallet on a chain.
 *
 * Signs an authorization for address(0) which clears the code slot.
 * After revocation, sponsored (UserOp) execution no longer works on this
 * chain, but direct (type 2) transactions continue working normally.
 *
 * This is only needed if the operator explicitly wants to remove the
 * smart account code from the agent EOA. In normal operation, there is
 * no reason to revoke — it does not limit the agent in any way.
 */
export async function revoke7702Authorization(
  agentAccount: LocalAccount,
  chainId: number,
  kv: KVNamespace,
): Promise<Hex> {
  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId);
  const transport = http(rpcUrl, rpcUrl?.includes("alchemy.com")
    ? { fetchOptions: { headers: { Origin: ALCHEMY_ORIGIN } } }
    : undefined,
  );

  const walletClient = createWalletClient({
    account: agentAccount,
    chain,
    transport,
  });

  // Authorization for address(0) clears the 7702 code designation
  const authorization = await walletClient.signAuthorization({
    contractAddress: "0x0000000000000000000000000000000000000000" as Address,
  });

  const txHash = await walletClient.sendTransaction({
    to: agentAccount.address,
    value: 0n,
    authorizationList: [authorization],
  });

  // Clean up KV cache
  const kvKey = `7702-auth:${agentAccount.address.toLowerCase()}:${chainId}`;
  await kv.delete(kvKey);

  return txHash;
}

/**
 * Check if the agent wallet has sufficient ETH for gas on a given chain.
 */
export async function checkAgentBalance(
  env: Env,
  vaultAddress: string,
  chainId: number,
): Promise<{ address: Address; balance: bigint; sufficient: boolean }> {
  const agentAccount = await loadAgentWalletAccount(
    env.KV,
    vaultAddress,
    env,
  );
  if (!agentAccount) {
    throw new ExecutionError("Agent wallet not found", "AGENT_WALLET_NOT_FOUND");
  }

  const client = getRpcProvider(chainId);
  const balance = await client.getBalance({ address: agentAccount.address });
  const minBal = MIN_BALANCE[chainId];
  if (minBal === undefined) {
    throw new ExecutionError(
      `Unsupported chain ID: ${chainId}. No minimum-balance threshold is configured for this chain.`,
      "UNSUPPORTED_CHAIN",
    );
  }

  return {
    address: agentAccount.address,
    balance,
    sufficient: balance >= minBal,
  };
}

// ── Pending tx tracking ───────────────────────────────────────────────

/**
 * Store a pending (unconfirmed) transaction in KV for async monitoring.
 * Also maintains a per-vault index so users can ask "is my transaction stuck?"
 * without knowing the hash.
 *
 * For sponsored transactions that have not yet received an EVM hash, the record is
 * stored under the raw bundler callId so the poller can query wallet_getCallsStatus.
 */
async function storePendingTx(kv: KVNamespace, vaultAddress: string, result: ExecutionResult): Promise<void> {
  // Pending sponsored transactions have no EVM hash yet; use the callId for the key.
  const lookupValue = result.sponsored && result.callId
    ? result.callId
    : result.txHash;
  if (!lookupValue) return;
  const key = `pending-tx:${lookupValue}`;

  await kv.put(key, JSON.stringify({
    ...result,
    storedAt: Date.now(),
  }), { expirationTtl: 3600 });

  // Per-vault index keyed by chain so we can look up the latest pending tx.
  // Store the value we will query: EVM hash if available, otherwise callId.
  const indexKey = `pending-tx-by-vault:${vaultAddress.toLowerCase()}:${result.chainId}`;
  await kv.put(indexKey, lookupValue, { expirationTtl: 3600 });
}

/** KV key for the per-vault pending transaction index. */
export function getPendingTxIndexKey(vaultAddress: string, chainId: number): string {
  return `pending-tx-by-vault:${vaultAddress.toLowerCase()}:${chainId}`;
}

/**
 * Get the latest pending transaction hash for a vault on a chain.
 * Returns null if no pending tx is recorded.
 */
export async function getPendingTxHashForVault(
  kv: KVNamespace,
  vaultAddress: string,
  chainId: number,
): Promise<string | null> {
  return kv.get(getPendingTxIndexKey(vaultAddress, chainId));
}

/**
 * Check the latest pending transaction for a vault and return a user-friendly summary.
 * Returns null if there is no recorded pending tx.
 */
export async function checkPendingTxForVault(
  env: Env,
  vaultAddress: string,
  chainId: number,
): Promise<{
  status: "confirmed" | "reverted" | "pending" | "unknown";
  txHash?: string;
  explorerUrl?: string;
  blockNumber?: number;
  message: string;
} | null> {
  const hash = await getPendingTxHashForVault(env.KV, vaultAddress, chainId);
  if (!hash) return null;

  const result = await checkPendingTxStatus(env, hash, chainId, vaultAddress);
  if (!result) {
    return {
      status: "pending",
      message: `A transaction is still pending on chain ${chainId}. It may take a few minutes to land, especially on Ethereum mainnet.`,
    };
  }

  if (result.confirmed) {
    return {
      status: "confirmed",
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      blockNumber: result.blockNumber,
      message: `Transaction <code>${result.txHash}</code> confirmed in block ${result.blockNumber}.${result.explorerUrl ? ` <a href="${result.explorerUrl}">View on explorer</a>` : ""}`,
    };
  }

  return {
    status: "reverted",
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
    message: `Transaction <code>${result.txHash}</code> reverted on-chain.${result.explorerUrl ? ` <a href="${result.explorerUrl}">View on explorer</a>` : ""}`,
  };
}

/**
 * Check the status of a pending transaction.
 * If a receipt is found, cleans up both the tx record and the per-vault index.
 *
 * The identifier is always one of two things:
 *   - an EVM transaction hash (64 bytes, 66 chars with 0x) for direct broadcasts;
 *   - an Alchemy sponsored callId (128 bytes, 130 chars with 0x) for sponsored tx.
 *
 * When we have a stored record, we know exactly which one it is (direct/sponsored),
 * so we never need to guess. When there is no stored record, we fall back to the
 * identifier length to route the lookup correctly.
 */
export async function checkPendingTxStatus(
  env: Env,
  hash: string,
  chainId: number,
  vaultAddress?: string,
): Promise<ExecutionResult | null> {
  const publicClient = getRpcProvider(chainId);

  // Normalize to a lowercase 0x-prefixed string for consistent KV keys.
  const normalized = hash.toLowerCase().startsWith("0x") ? hash.toLowerCase() : `0x${hash.toLowerCase()}`;
  const isEvmHash = /^0x[0-9a-f]{64}$/.test(normalized);
  const isCallId = /^0x[0-9a-f]{128}$/.test(normalized);

  let stored: ExecutionResult | null = null;
  try {
    const raw = await env.KV.get(`pending-tx:${normalized}`);
    if (raw) stored = JSON.parse(raw) as ExecutionResult;
  } catch {
    // ignore malformed stored record
  }

  const sponsored = stored?.sponsored ?? false;
  const storedTxHash = stored?.txHash?.toLowerCase();
  const storedCallId = stored?.callId?.toLowerCase();

  const buildResult = async (receipt: TransactionReceipt, txHash: Hex): Promise<ExecutionResult> => {
    const explorerBase = EXPLORER_TX_URL[chainId];
    const cost = receipt.gasUsed * receipt.effectiveGasPrice;

    const result: ExecutionResult = {
      txHash,
      chainId,
      confirmed: receipt.status === "success",
      reverted: receipt.status !== "success",
      blockNumber: Number(receipt.blockNumber),
      explorerUrl: explorerBase ? `${explorerBase}${txHash}` : undefined,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      gasCostEth: formatEther(cost),
      sponsored,
    };

    // Clean up the original lookup key, the resolved hash, and any stored callId.
    const keysToDelete = new Set<string>([`pending-tx:${normalized}`]);
    if (storedTxHash && storedTxHash !== normalized) keysToDelete.add(`pending-tx:${storedTxHash}`);
    if (txHash !== normalized && txHash !== storedTxHash) keysToDelete.add(`pending-tx:${txHash}`);
    if (storedCallId && storedCallId !== normalized) keysToDelete.add(`pending-tx:${storedCallId}`);
    for (const key of keysToDelete) {
      await env.KV.delete(key).catch(() => {});
    }
    if (vaultAddress) {
      await env.KV.delete(getPendingTxIndexKey(vaultAddress, chainId));
    }
    return result;
  };

  // Direct broadcast: the stored record always points to the EVM txHash.
  if (storedTxHash || (!sponsored && isEvmHash)) {
    const lookupHash = storedTxHash || normalized;
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: lookupHash as Hex });
      if (receipt) {
        return await buildResult(receipt, lookupHash as Hex);
      }
    } catch {
      // not found on-chain yet
    }
  }

  // Sponsored broadcast: resolve through the Alchemy bundler via the stored callId.
  const callId = storedCallId || (isCallId ? normalized : undefined);
  if (callId) {
    try {
      const sponsoredStatus = await getSponsoredCallsStatus(callId, chainId);
      const resolvedHash = sponsoredStatus.receipts?.[0]?.transactionHash;
      if (resolvedHash) {
        const onChainReceipt = await publicClient.getTransactionReceipt({ hash: resolvedHash });
        if (onChainReceipt) {
          return await buildResult(onChainReceipt, resolvedHash);
        }
      }
    } catch (err) {
      console.warn(
        `[execution] UserOp status resolution failed for ${callId} on chain ${chainId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return null;
}

export { ExecutionError } from "./executionError.js";


// ── Shared multi-tx execution helper ──────────────────────────────────

/** Result of executing a single transaction in a batch */
export interface TxExecOutcome {
  tx: UnsignedTransaction | TransactionDraft;
  result?: ExecutionResult;
  error?: string;
  /** When true, the user can sign this transaction directly from their wallet. */
  fallbackToManual?: boolean;
}

/**
 * Execute a list of unsigned transactions via delegation, collecting
 * per-tx results. Used by both the web chat and Telegram handlers.
 *
 * @param onProgress - Optional callback invoked before each tx starts,
 *   with the index, total count, and outcomes so far.
 */
export async function executeTxList(
  env: Env,
  txList: UnsignedTransaction[],
  vaultAddress: string,
  onProgress?: (index: number, total: number, outcomesSoFar: TxExecOutcome[]) => Promise<void>,
  requestCache?: Map<string, Promise<{ unitaryValue: bigint; totalValue: bigint; timestamp: bigint }>>,
): Promise<TxExecOutcome[]> {
  const outcomes: TxExecOutcome[] = [];
  for (let i = 0; i < txList.length; i++) {
    const tx = txList[i];
    if (onProgress) await onProgress(i, txList.length, outcomes);
    try {
      const result = await executeViaDelegation(env, tx, vaultAddress, undefined, requestCache);
      outcomes.push({ tx, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fallbackToManual = err instanceof ExecutionError ? err.fallbackToManual : false;
      outcomes.push({ tx, error: sanitizeError(msg), fallbackToManual });
    }
  }
  return outcomes;
}

// ── Pending simulation store (short-lived KV holding cell) ──────────────

const PENDING_SIMULATION_TTL_SECONDS = 600; // 10 minutes

/**
 * Minimal broadcast payload stored server-side between "prepare" and "execute".
 * Only the fields required to broadcast the transaction plus display helpers are
 * kept. operatorOnly, revertWarning, and navShieldChecked are intentionally
 * omitted — non-executable transactions are rejected before they ever reach KV.
 */
interface StoredTransaction {
  from: Address;
  to: Address;
  data: Hex;
  value: string; // hex-encoded wei
  chainId: number;
  gas: string; // hex-encoded gas limit
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  description: string;
  swapMeta?: TransactionDraft["swapMeta"];
  metrics?: Record<string, unknown>;
}

interface PendingSimulation {
  operationId: string;
  vaultAddress: string;
  /** Lowercased operator address that created the operation (defense in depth). */
  operatorAddress?: string;
  reply: string;
  txs: StoredTransaction[];
  createdAt: number;
  consumed?: boolean;
}

function toStoredTransaction(tx: UnsignedTransaction): StoredTransaction {
  return {
    from: tx.from,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    chainId: tx.chainId,
    gas: tx.gas,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    description: tx.description,
    swapMeta: tx.swapMeta,
    metrics: tx.metrics,
  };
}

function fromStoredTransaction(tx: StoredTransaction): UnsignedTransaction {
  return {
    ...tx,
    navShieldChecked: true,
  };
}

export function getPendingSimulationKey(operationId: string): string {
  return `pending-sim:${operationId}`;
}

function generateOperationId(): string {
  return crypto.randomUUID();
}

/**
 * Store a finalized, executable set of transactions and return an operationId.
 * `operatorAddress` is recorded (lowercased) so the confirmation path can verify
 * the stored bundle still belongs to the authenticated operator.
 */
export async function storePendingSimulation(
  kv: KVNamespace,
  vaultAddress: string,
  reply: string,
  txs: UnsignedTransaction[],
  operatorAddress?: string,
): Promise<string> {
  const operationId = generateOperationId();
  const stored: PendingSimulation = {
    operationId,
    vaultAddress: vaultAddress.toLowerCase(),
    operatorAddress: operatorAddress?.toLowerCase(),
    reply,
    txs: txs.map(toStoredTransaction),
    createdAt: Date.now(),
    consumed: false,
  };
  await kv.put(
    getPendingSimulationKey(operationId),
    JSON.stringify(stored),
    { expirationTtl: PENDING_SIMULATION_TTL_SECONDS },
  );
  return operationId;
}

/**
 * Consume a pending simulation by operationId. Returns null if unknown, expired,
 * or already consumed. Marking it consumed before returning prevents replay.
 */
export async function consumePendingSimulation(
  kv: KVNamespace,
  operationId: string,
): Promise<PendingSimulation | null> {
  const key = getPendingSimulationKey(operationId);
  const raw = await kv.get(key);
  if (!raw) return null;

  let stored: PendingSimulation;
  try {
    stored = JSON.parse(raw) as PendingSimulation;
  } catch {
    return null;
  }
  if (stored.consumed) return null;

  stored.consumed = true;
  await kv.put(key, JSON.stringify(stored), { expirationTtl: PENDING_SIMULATION_TTL_SECONDS });
  return stored;
}

/**
 * Execute a previously stored simulation bundle by operation ID.
 *
 * This is the confirmation-path entry point: it retrieves the finalized
 * transactions (with gas, fees, and NAV-shield already attached), marks the
 * bundle consumed to prevent replay, and broadcasts without re-running the LLM
 * or re-estimating gas.
 *
 * Defense in depth: `operatorAddress` (the authenticated operator from the
 * confirmation request) must match the operator recorded when the bundle was
 * stored. When omitted, the check is skipped for backwards compatibility but
 * a warning is logged — call sites should always pass the verified operator.
 */
export async function executeStoredSimulation(
  env: Env,
  operationId: string,
  vaultAddress: string,
  operatorAddress?: string,
  requestCache?: Map<string, Promise<{ unitaryValue: bigint; totalValue: bigint; timestamp: bigint }>>,
  onProgress?: (index: number, total: number, outcomesSoFar: TxExecOutcome[]) => Promise<void>,
): Promise<TxExecOutcome[]> {
  const stored = await consumePendingSimulation(env.KV, operationId);
  if (!stored) {
    throw new ExecutionError(
      `Operation ${operationId} is unknown, expired, or already executed. Please request a fresh quote.`,
      "OPERATION_NOT_FOUND",
      true,
    );
  }

  // Defense in depth: the stored vault must match the caller's vault.
  if (stored.vaultAddress.toLowerCase() !== vaultAddress.toLowerCase()) {
    throw new ExecutionError(
      "Stored operation does not match the requested vault.",
      "VAULT_MISMATCH",
      true,
    );
  }

  // Defense in depth: the stored operator must match the authenticated operator.
  if (operatorAddress) {
    if (!stored.operatorAddress || stored.operatorAddress !== operatorAddress.toLowerCase()) {
      throw new ExecutionError(
        "Stored operation does not belong to the authenticated operator.",
        "OPERATOR_MISMATCH",
        true,
      );
    }
  } else {
    console.warn(
      `[execution] executeStoredSimulation(${operationId}) called without operatorAddress — ` +
      "operator identity not verified at execution time.",
    );
  }

  return executeTxList(
    env,
    stored.txs.map(fromStoredTransaction),
    vaultAddress,
    onProgress,
    requestCache,
  );
}

/**
 * Format executeTxList outcomes into a markdown summary string
 * suitable for returning in ChatResponse.reply.
 */
export function formatOutcomesMarkdown(outcomes: TxExecOutcome[]): string {
  const parts: string[] = [];
  for (const { tx, result, error, fallbackToManual } of outcomes) {
    const desc = tx.description || "Transaction";
    if (result?.confirmed) {
      const gasInfo = result.gasCostEth ? ` Gas: ${result.gasCostEth} ETH.` : "";
      const link = result.explorerUrl || result.txHash;
      const fallbackNote = result.sponsoredFallbackReason
        ? `\n\nℹ️ ${result.sponsoredFallbackReason}`
        : "";
      parts.push(`✅ ${desc} confirmed in block ${result.blockNumber || "?"}.${gasInfo} [View](${link})${fallbackNote}`);
    } else if (result?.reverted) {
      const gasWasted = result.gasCostEth ? ` (gas spent: ${result.gasCostEth} ETH)` : "";
      const link = result.explorerUrl || result.txHash;
      parts.push(`⚠️ ${desc} reverted on-chain${gasWasted}. [View failed tx](${link})`);
    } else if (result) {
      const fallbackNote = result.sponsoredFallbackReason
        ? `\n\nℹ️ ${result.sponsoredFallbackReason}`
        : "";
      const pendingNote = result.sponsored && result.gasCostEth?.includes("timed out")
        ? " The status check timed out; the transaction may still confirm on-chain."
        : " Waiting for confirmation…";
      const checkHint = " Ask me for a status update anytime (e.g. \"is my transaction stuck?\").";

      if (result.sponsored && !result.txHash) {
        // Pending sponsored transactions have no EVM hash yet. The UserOp / callId
        // is not user-facing; it is only used for internal polling.
        parts.push(
          `⏳ ${desc} submitted (sponsored).\n` +
            `The on-chain transaction hash will appear once the bundle is included.${pendingNote}${checkHint}${fallbackNote}`,
        );
      } else {
        const link = result.explorerUrl || result.txHash;
        parts.push(
          `⏳ ${desc} submitted.\n` +
            `${result.sponsored ? "Sponsored transaction hash" : "Transaction hash"}: \`${result.txHash}\`${pendingNote}${checkHint}${fallbackNote}`,
        );
      }
    } else if (error) {
      const fallbackHint = fallbackToManual
        ? " You can sign this transaction directly from your wallet."
        : "";
      parts.push(`❌ ${desc} failed: ${error}.${fallbackHint}`);
    }
  }
  if (outcomes.some(o => o.result?.reverted)) {
    parts.push("Would you like to retry the failed transaction(s) with fresh parameters?");
  }
  return parts.join("\n\n");
}
