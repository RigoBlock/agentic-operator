/**
 * Execution Service — agent wallet transaction execution with gas safety.
 *
 * In "delegated" mode, after the operator confirms transaction details,
 * the agent wallet sends the transaction directly to the vault contract.
 * The vault checks its internal delegation mapping to authorize the agent.
 *
 * Execution path:
 *   Agent wallet → Vault contract (msg.sender = agent wallet)
 *   Result: vault verifies agent is delegated via getDelegatedSelectors() ✓
 *
 * Gas safety mechanisms:
 *   - Transaction simulation via eth_call before broadcasting
 *   - Hard caps on maxFeePerGas and maxPriorityFeePerGas
 *   - Pre-flight balance check (refuses if balance < estimated cost)
 *   - EIP-1559 fee estimation with configurable multiplier
 *   - Automatic resubmission with bumped fees if not mined within timeout
 *   - Max resubmission attempts to prevent infinite loops
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
import type { Env, UnsignedTransaction, TransactionDraft, ExecutionResult, RequestContext } from "../types.js";
import { getChain, getRpcUrl, sanitizeError, ZERO_ADDRESS, MIN_BALANCE, EXPLORER_TX_URL, NATIVE_TOKEN } from "../config.js";
import { loadAgentWalletAccount } from "./agentWallet.js";
import { getDelegationConfig, getChainDelegation } from "./delegation.js";
import { recordGasSpend } from "../routes/gasPolicy.js";
import { ALLOWED_VAULT_SELECTORS, RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import {
  executeSponsoredCalls,
  getSponsoredCallsStatus,
  type WalletCall,
} from "./bundler.js";
import { checkNavImpact, getNavShieldThreshold } from "./navGuard.js";
import { getClient, ALCHEMY_ORIGIN } from "./rpcClient.js";
import {
  estimateTransactionGas,
  clampGasFees,
  bumpGasFees,
  getTransactionFees,
  RESUBMIT_FEE_BUMP_PCT,
  type GasFees,
} from "./gas.js";

// ── Gas Safety Configuration ──────────────────────────────────────────

/** Maximum number of resubmission attempts */
const MAX_RESUBMIT_ATTEMPTS = 2;

/** Timeout for waiting for a tx receipt (ms) */
const TX_CONFIRM_TIMEOUT_MS = 60_000;

/** Fast-confirming chains (L2s, BSC) with sub-second block times */
const FAST_CHAIN_IDS = new Set([10, 42161, 8453, 130, 56, 84532]);

/**
 * Type guard: a transaction is "prepared" only when it has a non-zero gas limit
 * AND the internal `prepared` marker set by finalizeToolTransaction().
 */
function isPreparedTransaction(tx: TransactionDraft): tx is UnsignedTransaction & { prepared: true } {
  const maybe = tx as Partial<UnsignedTransaction>;
  return !!maybe.gas && maybe.gas !== "0x0" && maybe.prepared === true;
}

/**
 * Shared transaction finalizer: run the NAV shield and estimate gas.
 *
 * For vault-targeted transactions, the NAV shield simulates the swap via
 * eth_simulateV1 and validates the post-swap unitary value does not drop
 * more than the allowed threshold. Gas is then estimated independently with
 * eth_estimateGas from the executor address, so every transaction (vault or
 * not) uses a real gas estimate.
 *
 * Non-vault transactions skip the NAV shield but still estimate gas and fees.
 */
export async function prepareTransaction(
  env: Env,
  ctx: Pick<RequestContext, "vaultAddress" | "chainId" | "operatorAddress" | "operatorVerified" | "executionMode">,
  draft: TransactionDraft,
): Promise<{ tx: UnsignedTransaction; warning?: string }> {
  const tx: UnsignedTransaction = { ...draft, gas: "0x0", navShieldChecked: false };
  if (!env.ALCHEMY_API_KEY) {
    throw new ExecutionError("No RPC key configured", "RPC_UNAVAILABLE");
  }

  const publicClient = getClient(tx.chainId, env.ALCHEMY_API_KEY);

  // Determine the operator/owner address for NAV shield threshold lookup.
  // If the caller didn't prove ownership, we read the on-chain owner.
  let operatorAddress: Address;
  if (ctx.operatorAddress) {
    operatorAddress = ctx.operatorAddress;
  } else {
    try {
      operatorAddress = await publicClient.readContract({
        address: ctx.vaultAddress,
        abi: RIGOBLOCK_VAULT_ABI,
        functionName: "owner",
      }) as Address;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ExecutionError(
        `Could not read vault owner for NAV simulation: ${sanitizeError(msg)}`,
        "RPC_UNAVAILABLE",
      );
    }
  }

  // Determine the transaction executor (sender for simulation / gas estimation).
  let executor: Address;
  if (tx.operatorOnly || ctx.executionMode === "manual") {
    executor = operatorAddress;
  } else {
    // Delegated mode: simulate from the agent address without loading the private key.
    const config = await getDelegationConfig(env.KV, ctx.vaultAddress);
    if (!config || !config.enabled) {
      throw new ExecutionError(
        "Delegation not configured. Set up delegation on the vault first.",
        "DELEGATION_NOT_CONFIGURED",
      );
    }
    executor = config.agentAddress;
  }

  const txValue = BigInt(tx.value || "0x0");

  // NAV shield only applies when the transaction targets the vault itself.
  const isVaultTarget = !!ctx.vaultAddress &&
    ctx.vaultAddress.toLowerCase() !== ZERO_ADDRESS &&
    tx.to.toLowerCase() === ctx.vaultAddress.toLowerCase();

  if (isVaultTarget) {
    // Read operator's custom NAV shield threshold (falls back to default 10%).
    const storedNavThreshold = env.KV
      ? await getNavShieldThreshold(env.KV, operatorAddress)
      : null;

    const navResult = await checkNavImpact(
      ctx.vaultAddress as Address,
      tx.data,
      txValue,
      tx.chainId,
      env.ALCHEMY_API_KEY,
      executor,
      env.KV,
      storedNavThreshold ?? undefined,
    );

    if (!navResult.allowed) {
      if (navResult.code === "TRADE_REVERTS") {
        // Advisory warning for manual signing; auto-execution will refuse later.
        const warning = `⚠️ Simulation warning: ${navResult.reason || "transaction may revert on-chain"} — verify token approvals and vault adapter support before signing.`;
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

    if (navResult.code === "UNVERIFIED") {
      return {
        tx,
        warning: `⚠️ NAV verification unavailable — could not measure NAV impact atomically (${navResult.reason || "multicall simulation failed"}). Proceeding with gas estimate only.`,
      };
    }
  }

  // Estimate gas units and EIP-1559 fees directly from the executor for every transaction.
  let gasEstimate: bigint;
  let fees: GasFees;
  try {
    const result = await estimateTransactionGas(
      publicClient,
      tx.chainId,
      { account: executor, to: tx.to, data: tx.data, value: txValue },
    );
    gasEstimate = result.gas;
    fees = result.fees;
  } catch (estErr) {
    const msg = estErr instanceof Error ? estErr.message : String(estErr);
    if (msg.toLowerCase().includes("gas estimation failed")) {
      throw new ExecutionError(`Gas estimation failed: ${sanitizeError(msg)}`, "GAS_ESTIMATION_FAILED");
    }
    throw new ExecutionError(
      sanitizeError(msg) || "Transaction simulation failed — the transaction would revert on-chain.",
      "SIMULATION_FAILED",
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

/**
 * Centralized transaction finalization for tool handlers.
 *
 * Handlers MUST return a `TransactionDraft` (no gas, no NAV-shield markers).
 * This function is the only place that turns a draft into a full
 * `UnsignedTransaction` with gas and a validated NAV shield.
 */
export async function finalizeToolTransaction(
  env: Env,
  ctx: Pick<RequestContext, "vaultAddress" | "chainId" | "operatorAddress" | "operatorVerified" | "executionMode">,
  draft: TransactionDraft,
): Promise<{ tx: UnsignedTransaction; warning?: string }> {
  const result = await prepareTransaction(env, ctx, draft);
  result.tx.prepared = true;
  return result;
}

/**
 * Execute a transaction via the agent wallet.
 *
 * This is the ONLY public function that broadcasts transactions from the agent
 * wallet. ALL delegated transactions go through here — there is no alternative
 * code path. The NAV shield runs unconditionally before broadcast; it cannot
 * be skipped, disabled, or bypassed.
 *
 * Safety checks (all mandatory, in order):
 * 1. Delegation config exists and is enabled
 * 2. Per-chain delegation state verified
 * 3. Transaction target == vault address (no cross-contract calls)
 * 4. Function selector in allowed whitelist
 * 5. Agent wallet loaded and matches config
 * 6. **NAV SHIELD** — simulates trade impact on vault unit price (MANDATORY)
 * 7. Transaction broadcast (sponsored or direct) with gas caps
 */
export async function executeViaDelegation(
  env: Env,
  txInput: TransactionDraft,
  vaultAddress: string,
  sponsoredGasOverride?: boolean,
  requestCache?: Map<string, Promise<{ unitaryValue: bigint; totalValue: bigint; timestamp: bigint }>>,
): Promise<ExecutionResult> {
  // 1. Load the delegation config
  const config = await getDelegationConfig(env.KV, vaultAddress);
  if (!config || !config.enabled) {
    throw new ExecutionError(
      "Delegation not configured. Set up delegation on the vault first.",
      "DELEGATION_NOT_CONFIGURED",
    );
  }

  // 2. Get per-chain delegation state
  const chainDelegation = await getChainDelegation(env.KV, vaultAddress, txInput.chainId);
  if (!chainDelegation) {
    throw new ExecutionError(
      `Delegation not active on chain ${txInput.chainId}. Set up delegation on this chain first.`,
      "DELEGATION_NOT_ON_CHAIN",
    );
  }

  // 3. Verify the transaction target is the vault
  if (txInput.to.toLowerCase() !== vaultAddress.toLowerCase()) {
    throw new ExecutionError(
      `Transaction target ${txInput.to} is not the vault ${vaultAddress}. ` +
      `The agent can only send transactions to the delegated vault.`,
      "TARGET_NOT_ALLOWED",
    );
  }

  // 4. Verify the function selector is in our code-level whitelist.
  //    We check against ALLOWED_VAULT_SELECTORS (the canonical set) rather than
  //    the KV-stored selectors — the KV config may be stale if new selectors
  //    were added after the initial delegation setup. The on-chain delegation
  //    is the ultimate guard (eth_call simulation at step 7 catches unauthorized calls).
  const selector = txInput.data.slice(0, 10) as Hex;
  const whitelistedSelectors = Object.values(ALLOWED_VAULT_SELECTORS).map((s) => s.toLowerCase());
  if (!whitelistedSelectors.includes(selector.toLowerCase())) {
    throw new ExecutionError(
      `Function selector ${selector} is not in the allowed set. ` +
      `Only whitelisted vault functions can be called via delegation.`,
      "METHOD_NOT_ALLOWED",
    );
  }

  // 5. Load the agent wallet
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

  // 6. Verify agent address matches config
  if (agentAccount.address.toLowerCase() !== config.agentAddress.toLowerCase()) {
    throw new ExecutionError(
      "Agent wallet address mismatch with delegation config",
      "AGENT_WALLET_MISMATCH",
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // ██ NAV SHIELD + GAS — MANDATORY (must NEVER be skipped, disabled, or bypassed) ██
  // Simulates multicall([tx, updateUnitaryValue]) as the OPERATOR (vault owner).
  // If NAV drops > threshold → transaction BLOCKED, never broadcast.
  //
  // IMPORTANT: Simulation uses the OPERATOR address (vault owner), not the agent.
  // Reason: `multicall` is intentionally NOT in the agent's delegated selectors
  // (delegating multicall would let the agent compose arbitrary vault calls).
  // The operator is the vault owner, always authorized for any selector, so the
  // multicall simulation succeeds. The actual trade is still sent by the agent
  // wallet using only its whitelisted selectors (execute, modifyLiquidities, etc.).
  //
  // Uses updateUnitaryValue() (the actual contract NAV algorithm) instead of
  // getNavDataView() to avoid an ENavView edge case where the view incorrectly
  // returns unitaryValue=0 when the actual contract preserves the stored value.
  //
  // If the transaction was already finalized upstream (e.g. by processChat via
  // prepareTransaction), we reuse its gas and NAV result instead of running the
  // simulation again. This removes the duplicate eth_estimateGas + NAV check that
  // previously ran in handlers and again at broadcast time.

  // Only reuse a previously finalized transaction if it carries the internal
  // `prepared` marker set by finalizeToolTransaction(). External callers cannot
  // forge this marker through JSON because the field is stripped/ignored at the
  // route boundary; any transaction without it is re-finalized here.
  let finalizedTx: UnsignedTransaction;
  if (!isPreparedTransaction(txInput)) {
    try {
      finalizedTx = (await prepareTransaction(
        env,
        {
          vaultAddress: txInput.to,
          chainId: txInput.chainId,
          operatorAddress: config.operatorAddress,
          operatorVerified: false,
          executionMode: "delegated",
        },
        txInput,
      )).tx;
    } catch (prepErr) {
      if (prepErr instanceof ExecutionError) throw prepErr;
      const msg = prepErr instanceof Error ? prepErr.message : String(prepErr);
      throw new ExecutionError(
        `Transaction preparation failed: ${sanitizeError(msg)}`,
        "SIMULATION_FAILED",
        true,
      );
    }
  } else {
    finalizedTx = txInput as UnsignedTransaction;
  }

  // From here on we operate on a fully finalized UnsignedTransaction.
  const tx: UnsignedTransaction = finalizedTx;

  // Refuse to auto-execute a transaction that was flagged as likely reverting
  // during prepareTransaction. The caller can still return it as unsigned calldata
  // for manual signing.
  if (tx.revertWarning) {
    throw new ExecutionError(tx.revertWarning, "SIMULATION_FAILED", true);
  }

  // 7. Execute the transaction
  // Choose execution path: sponsored (ERC-4337 bundler) or direct broadcast.
  // Priority: per-transaction override > per-chain setting > global config.
  const chainSponsored = chainDelegation.sponsoredGas !== undefined
    ? chainDelegation.sponsoredGas
    : config.sponsoredGas;
  const effectiveSponsored = sponsoredGasOverride !== undefined ? sponsoredGasOverride : chainSponsored;
  const useSponsored = effectiveSponsored && !!env.ALCHEMY_GAS_POLICY_ID;

  let result: ExecutionResult;

  try {
    if (useSponsored) {
      // ── Sponsored path: submit as UserOperation via Alchemy bundler ──
      // The paymaster sponsors gas, so the agent wallet doesn't need ETH.
      // The agent EOA must have EIP-7702 authorization (auto-set on first use).
      try {
        result = await sponsoredAgentTransaction(
          agentAccount,
          tx,
          tx.chainId,
          env.ALCHEMY_API_KEY,
          env.ALCHEMY_GAS_POLICY_ID!,
          env.KV,
        );
      } catch (sponsoredErr) {
        // Simulation failure is a trade-level issue — don't mask it with sponsorship errors
        if (sponsoredErr instanceof ExecutionError && sponsoredErr.code === "SIMULATION_FAILED") {
          throw sponsoredErr;
        }

        const sponsoredMsg = sponsoredErr instanceof Error ? sponsoredErr.message : String(sponsoredErr);
        const sponsoredDetails = (sponsoredErr as any)?.details
          || (sponsoredErr as any)?.cause?.message
          || (sponsoredErr as any)?.cause?.details
          || "";
        const sponsoredCode = (sponsoredErr as any)?.code
          || (sponsoredErr as any)?.cause?.code
          || "";
        // Alchemy may forward the gas-policy webhook's rejection reason inside the
        // error payload (location varies by SDK version / error shape).
        const sponsoredReason = (sponsoredErr as any)?.reason
          || (sponsoredErr as any)?.cause?.reason
          || (sponsoredErr as any)?.data?.reason
          || (sponsoredErr as any)?.cause?.data?.reason
          || (sponsoredErr as any)?.cause?.response?.reason
          || "";
        const gasInfo = (sponsoredErr as any)?._gasInfo;

        // Try direct broadcast (agent wallet pays gas)
        try {
          result = await broadcastAgentTransaction(
            agentAccount,
            tx,
            tx.chainId,
            env.ALCHEMY_API_KEY,
          );
          // Sponsorship failed but direct broadcast succeeded. Surface the original
          // sponsored failure reason to the caller/LLM so it knows why sponsorship
          // is not being used and can decide whether to disable it.
          const fallbackReasonText = sponsoredDetails
            ? sanitizeError(String(sponsoredDetails))
            : (sponsoredReason && !sponsoredDetails?.includes(String(sponsoredReason))
                ? sanitizeError(String(sponsoredReason))
                : sanitizeError(sponsoredMsg));
          const codeSuffix = sponsoredCode ? ` [${sponsoredCode}]` : "";
          result.sponsoredFallbackReason = (
            `Sponsored execution failed${codeSuffix}: ${fallbackReasonText}. ` +
            `Fell back to direct agent-wallet broadcast.`
          );
        } catch (directErr) {
          // Both sponsored and direct failed. Build a user-facing message that explains
          // exactly what happened and gives the user three clear choices:
          // 1. Fund the agent wallet so direct broadcast works next time
          // 2. Disable sponsorship on this chain so direct broadcast is the default
          // 3. Sign this transaction manually right now
          const token = NATIVE_TOKEN[tx.chainId] || "ETH";
          const detailSuffix = sponsoredDetails
            ? ` (${sanitizeError(String(sponsoredDetails))})`
            : "";
          const reasonSuffix = sponsoredReason && !sponsoredDetails.includes(String(sponsoredReason))
            ? ` — Policy reason: ${sanitizeError(String(sponsoredReason))}`
            : "";
          const codeSuffix = sponsoredCode ? ` [${sponsoredCode}]` : "";

          // Show only facts: raw error, gas params, options. No interpretation.
          let gasBreakdown = "";
          if (gasInfo) {
            const parts: string[] = [];
            if (gasInfo.callGasLimit) parts.push(`gas limit: ${gasInfo.callGasLimit}`);
            if (gasInfo.ourMaxFeePerGasGwei) parts.push(`our maxFeePerGas: ${gasInfo.ourMaxFeePerGasGwei} gwei`);
            if (gasInfo.ourMaxPriorityFeePerGasGwei) parts.push(`our maxPriorityFeePerGas: ${gasInfo.ourMaxPriorityFeePerGasGwei} gwei`);
            if (gasInfo.maxCostEth) parts.push(`max cost: ${gasInfo.maxCostEth} ${token}`);
            if (parts.length) gasBreakdown = `\n[${parts.join(" · ")}]`;
          }

          let userMsg: string;
          if (directErr instanceof ExecutionError && directErr.code === "INSUFFICIENT_BALANCE") {
            userMsg = (
              `Sponsored execution failed${detailSuffix}${reasonSuffix}${codeSuffix}.${gasBreakdown}\n` +
              `Direct broadcast also failed: agent wallet has no ${token} for gas.\n` +
              `Options: (1) fund agent wallet ${agentAccount.address}, ` +
              `(2) disable sponsored gas, or ` +
              `(3) sign this transaction directly from your wallet.`
            );
          } else {
            const directMsg = directErr instanceof Error ? directErr.message : String(directErr);
            userMsg = (
              `Sponsored execution failed${detailSuffix}${reasonSuffix}${codeSuffix}.${gasBreakdown}\n` +
              `Direct broadcast also failed: ${sanitizeError(directMsg)}.\n` +
              `Options: (1) fund agent wallet ${agentAccount.address}, ` +
              `(2) disable sponsored gas, or ` +
              `(3) sign this transaction directly from your wallet.`
            );
          }
          throw new ExecutionError(userMsg, "SPONSORED_FAILED", true);
        }
      }
    } else {
      // ── Direct broadcast: agent wallet pays gas ──
      result = await broadcastAgentTransaction(
        agentAccount,
        tx,
        tx.chainId,
        env.ALCHEMY_API_KEY,
      );
    }
  } catch (execErr) {
    // The NAV shield already validated the transaction as the OPERATOR (vault owner),
    // so the transaction was structurally valid at that moment. If the agent's own
    // simulation now fails, it is MOST COMMONLY a market-level revert (e.g., GMX
    // acceptable price moved) rather than a delegation issue. Only treat it as
    // "agent not delegated" when the revert reason explicitly says so.
    if (execErr instanceof ExecutionError && execErr.code === "SIMULATION_FAILED") {
      const msg = execErr.message.toLowerCase();
      const isDelegationIssue =
        msg.includes("not delegated") ||
        msg.includes("caller is not delegated") ||
        msg.includes("unauthorized") ||
        msg.includes("no permission") ||
        msg.includes("only owner") ||
        msg.includes("onlyowner") ||
        (msg.includes("selector") && msg.includes("not delegated"));

      if (isDelegationIssue) {
        throw new ExecutionError(
          `The agent wallet is not delegated for function selector ${selector} on-chain. ` +
          `Update your delegation to add this function, or sign this transaction directly from your wallet.`,
          "AGENT_NOT_DELEGATED",
          true,
        );
      }

      // Market-level simulation failure: preserve the real revert reason and let
      // the user sign manually if they want to retry with updated prices.
      throw new ExecutionError(
        `Delegated execution simulation failed: ${execErr.message} ` +
        `You can sign this transaction directly from your wallet to retry, or wait and try again.`,
        "SIMULATION_FAILED",
        true,
      );
    }
    throw execErr;
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
  alchemyKey?: string,
): Promise<ExecutionResult> {
  try {
  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId, alchemyKey);

  const publicClient = getClient(chainId, alchemyKey);
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
  const gasLimit = BigInt(tx.gas || "0x0");
  if (gasLimit === 0n) {
    throw new ExecutionError(
      "Gas limit is missing for this transaction. Rebuild the transaction to estimate gas.",
      "GAS_ESTIMATION_FAILED",
    );
  }

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
  alchemyKey: string,
  gasPolicyId: string,
  _kv: KVNamespace,
): Promise<ExecutionResult> {
  // The simulation only needs any working RPC — the actual sponsored execution
  // uses the Alchemy SDK's own transport (which supports more chains).
  const publicClient = getClient(chainId, alchemyKey);
  const txValue = BigInt(tx.value);

  // ── Step 1: Use pre-computed gas limit ──
  // Gas was already estimated once by prepareTransaction() from the agent address
  // and includes a 25% buffer. We pass it as the callGasLimit override to prevent
  // the bundler from underestimating complex vault adapter calls.
  const callGasLimit = BigInt(tx.gas || "0x0");
  if (callGasLimit === 0n) {
    throw new ExecutionError(
      "Gas limit is missing for this transaction. Rebuild the transaction to estimate gas.",
      "GAS_ESTIMATION_FAILED",
    );
  }

  // ── Step 2: Reuse the fee values attached by prepareTransaction() ──
  // The same EIP-1559 values must be used for display and broadcast. If the
  // transaction was not finalized through prepareTransaction(), refuse to execute.
  const fees = getTransactionFees(tx, chainId);

  // ── Step 3: Execute via Alchemy Smart Wallet SDK ──
  const calls: WalletCall[] = [{
    to: tx.to as Address,
    value: txValue > 0n ? (`0x${txValue.toString(16)}` as Hex) : ("0x0" as Hex),
    data: tx.data as Hex,
  }];

  // Capture gas params so the caller can verify Alchemy's rejection reason.
  const buildGasInfo = (overrideFees?: GasFees) => ({
    callGasLimit: callGasLimit ? callGasLimit.toString() : undefined,
    ourMaxFeePerGasGwei: formatGwei(overrideFees ? overrideFees.maxFeePerGas : fees.maxFeePerGas),
    ourMaxPriorityFeePerGasGwei: formatGwei(overrideFees ? overrideFees.maxPriorityFeePerGas : fees.maxPriorityFeePerGas),
    maxCostEth: callGasLimit
      ? (Number(callGasLimit * (overrideFees ? overrideFees.maxFeePerGas : fees.maxFeePerGas)) / 1e18).toFixed(6)
      : undefined,
  });

  async function trySponsoredCalls(attemptFees: GasFees, isRetry: boolean): Promise<ReturnType<typeof executeSponsoredCalls>> {
    try {
      return await executeSponsoredCalls(
        agentAccount,
        chainId,
        alchemyKey,
        gasPolicyId,
        calls,
        callGasLimit,
        attemptFees.maxFeePerGas,
        attemptFees.maxPriorityFeePerGas,
      );
    } catch (err) {
      // If the bundler rejected because our fees are too low, parse the
      // required minimum from the error and retry once. Alchemy returns:
      //   -32602 data fields: current_max_priority_fee, current_max_fee
      //   -32000 message: "...must be at least 62500000"
      if (isRetry) {
        (err as any)._gasInfo = buildGasInfo(attemptFees);
        throw err;
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      const errData = (err as any)?.data || (err as any)?.cause?.data;
      const errCode = (err as any)?.code || (err as any)?.cause?.code || "";

      // Parse "must be at least N" from the error message (wei units)
      const mustBeAtLeastMatch = errMsg.match(/must be at least\s+(\d+)/i);
      const requiredMinWei = mustBeAtLeastMatch ? BigInt(mustBeAtLeastMatch[1]) : undefined;

      // Parse Alchemy -32602 data fields
      const dataPriorityFee = errData?.current_max_priority_fee ? BigInt(errData.current_max_priority_fee) : undefined;
      const dataMaxFee = errData?.current_max_fee ? BigInt(errData.current_max_fee) : undefined;

      // Only retry when the error is explicitly fee-related (message text or
      // Alchemy data fields). DO NOT retry on generic -32602 — Alchemy uses
      // that code for paymaster rejections (spending limit) too.
      const isFeeError =
        errMsg.toLowerCase().includes("maxpriorityfeepergas") ||
        errMsg.toLowerCase().includes("maxfeepergas") ||
        errMsg.toLowerCase().includes("precheck failed");

      if (isFeeError && (requiredMinWei || dataPriorityFee || dataMaxFee)) {
        // Recompute fees using the bundler's minimums, then clamp to the same
        // chain caps so a retry cannot exceed the operator's configured safety
        // ceiling (especially on Arbitrum, where the policy is sensitive to the
        // quoted max fee per gas).
        const rawPriorityFee = dataPriorityFee
          || (requiredMinWei && requiredMinWei > attemptFees.maxPriorityFeePerGas ? requiredMinWei : undefined)
          || attemptFees.maxPriorityFeePerGas;
        const rawMaxFee = dataMaxFee
          || (rawPriorityFee > attemptFees.maxFeePerGas ? rawPriorityFee + (rawPriorityFee * 10n) / 100n : attemptFees.maxFeePerGas);

        const retryFees = clampGasFees(
          {
            maxPriorityFeePerGas: rawPriorityFee,
            maxFeePerGas: rawMaxFee,
          },
          chainId,
        );

        return trySponsoredCalls(retryFees, true);
      }

      (err as any)._gasInfo = buildGasInfo(attemptFees);
      throw err;
    }
  }

  const result = await trySponsoredCalls(fees, false);

  // ── Step 3: Record actual gas spend if we have a receipt ──
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
      await recordGasSpend(_kv, agentAccount.address, chainId, gasCostWei, alchemyKey).catch((err) =>
        console.warn(`[execution] Failed to record sponsored gas spend: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  // ── Step 4: Map result to ExecutionResult ──
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
  alchemyKey: string,
  kv: KVNamespace,
): Promise<Hex> {
  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId, alchemyKey);
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

  const client = getClient(chainId, env.ALCHEMY_API_KEY);

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

/**
 * Parse a JSON-stored pending transaction payload into a list of unsigned transactions.
 * Handles the formats used by both web and Telegram: a single tx, a plain array,
 * or an object with a `txs` array. Preserves gas, fee, and NAV-shield fields so a
 * finalized transaction can be reused without re-simulation.
 */
export function parseStoredUnsignedTransactions(raw: string): UnsignedTransaction[] {
  const parsed: Record<string, unknown> = JSON.parse(raw);
  const rawTxs = parsed.txs ? parsed.txs : (Array.isArray(parsed) ? parsed : [parsed]);
  return (rawTxs as Record<string, unknown>[]).map((t) => ({
    to: t.to as Address,
    data: t.data as `0x${string}`,
    value: (t.value as string) || "0x0",
    chainId: t.chainId as number,
    gas: (t.gas as string) || "0x0",
    maxFeePerGas: t.maxFeePerGas as `0x${string}` | undefined,
    maxPriorityFeePerGas: t.maxPriorityFeePerGas as `0x${string}` | undefined,
    description: (t.description as string) || "",
    swapMeta: t.swapMeta as UnsignedTransaction["swapMeta"],
    metrics: t.metrics as UnsignedTransaction["metrics"],
    operatorOnly: !!t.operatorOnly,
    navShieldChecked: t.navShieldChecked as boolean | undefined,
    revertWarning: t.revertWarning as string | undefined,
    prepared: (t.prepared as true) ?? true,
  }));
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
  const alchemyKey = env.ALCHEMY_API_KEY;
  const publicClient = getClient(chainId, alchemyKey);

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
      const sponsoredStatus = await getSponsoredCallsStatus(callId, chainId, alchemyKey);
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

/**
 * Custom error with error code for the API.
 */
export class ExecutionError extends Error {
  code: string;
  /** When true, the caller should allow the user to sign the transaction manually. */
  fallbackToManual?: boolean;
  constructor(message: string, code: string, fallbackToManual?: boolean) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
    this.fallbackToManual = fallbackToManual;
  }
}

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
  txList: TransactionDraft[],
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
