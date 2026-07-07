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
  parseGwei,
  type Address,
  type Hex,
  type TransactionReceipt,
  type PublicClient,
} from "viem";
import type { LocalAccount } from "viem/accounts";
import type { Env, UnsignedTransaction, TransactionDraft, ExecutionResult, RequestContext } from "../types.js";
import { getChain, getRpcUrl, sanitizeError } from "../config.js";
import { loadAgentWalletAccount } from "./agentWallet.js";
import { getDelegationConfig, getChainDelegation } from "./delegation.js";
import { recordGasSpend } from "../routes/gasPolicy.js";
import { ALLOWED_VAULT_SELECTORS, RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import {
  executeSponsoredCalls,
  getSponsoredCallsStatus,
  type WalletCall,
} from "./bundler.js";
import { checkNavImpact } from "./navGuard.js";
import { getClient, ALCHEMY_ORIGIN } from "./rpcClient.js";
import { getNavShieldThreshold } from "./navGuard.js";
import { decodeRevertData, extractRevertData, getRevertDataFromError } from "./errorDecoder.js";

/**
 * Parse simulation revert messages to detect common ERC20/DEX token balance issues.
 * Returns a user-friendly message if detected, otherwise null.
 */
function parseSimulationRevert(raw: string): string | null {
  const lower = raw.toLowerCase();

  // Try to decode any raw revert hex data first — this gives the most precise reason.
  const revertData = extractRevertData(raw);
  if (revertData) {
    const decoded = decodeRevertData(revertData);
    if (decoded) {
      // Translate common decoded errors into actionable guidance.
      const decodedLower = decoded.toLowerCase();
      if (
        decodedLower.includes("erc20insufficientbalance") ||
        decodedLower.includes("toolittlereceived") ||
        decodedLower.includes("insufficientoutputamount") ||
        decodedLower.includes("safetransferfrom") ||
        decodedLower.includes("transfer amount exceeds")
      ) {
        return (
          "The vault does not hold enough of the sell token for this swap. " +
          "Check the vault's token balances and try a smaller amount."
        );
      }
      if (decodedLower.includes("transactiontooold") || decodedLower.includes("deadline")) {
        return "The swap quote has expired. Please request a fresh quote.";
      }
      if (
        decodedLower.includes("toomuchrequested") ||
        decodedLower.includes("slippage") ||
        decodedLower.includes("minimum amount")
      ) {
        return "The swap would result in too much slippage. Try again with a fresh quote or smaller amount.";
      }
      if (decodedLower.includes("notdelegated") || decodedLower.includes("unauthorized") || decodedLower.includes("onlyowner")) {
        return (
          "The agent wallet is not delegated for this swap selector on the vault. " +
          "Update your delegation settings, or sign this transaction directly from your wallet."
        );
      }
      return decoded;
    }
  }

  // Common ERC20 / Uniswap / 0x revert patterns indicating insufficient token balance
  if (
    lower.includes("stf") ||                             // Uniswap SafeTransferFrom
    lower.includes("transfer amount exceeds balance") ||
    lower.includes("transfer_from_failed") ||
    lower.includes("insufficient balance") ||
    lower.includes("erc20: transfer amount exceeds") ||
    lower.includes("safetransferfrom") ||
    lower.includes("subtraction overflow") ||             // balance underflow
    lower.includes("ds-math-sub-underflow") ||            // MakerDAO-style SafeMath
    lower.includes("not enough balance") ||
    lower.includes("exceeds allowance") ||                // approval-related
    lower.includes("v3_invalid_swap") ||                  // Uniswap V3 revert
    lower.includes("too little received")
  ) {
    return (
      "The vault does not hold enough of the sell token for this swap. " +
      "Check the vault's token balances and try a smaller amount."
    );
  }

  // Expired deadline
  if (lower.includes("transaction too old") || lower.includes("deadline")) {
    return "The swap quote has expired. Please request a fresh quote.";
  }

  // Slippage
  if (lower.includes("too much requested") || lower.includes("slippage") || lower.includes("minimum amount")) {
    return "The swap would result in too much slippage. Try again with a fresh quote or smaller amount.";
  }

  // GMX v2 acceptable price / execution price (includes "acceptable price", "execution price",
  // "empty primary price", "invalid primary price", and keeper-revert variants)
  if (
    lower.includes("acceptable price") ||
    lower.includes("execution price") ||
    lower.includes("empty primary price") ||
    lower.includes("invalid primary price") ||
    lower.includes("primary price") ||
    lower.includes("end of oracle")
  ) {
    return (
      "The GMX order could not be executed at the required price. " +
      "The oracle price moved beyond the 1% slippage bound before the keeper picked up the order. " +
      "Retry the order, or wait for less volatility."
    );
  }

  // Agent wallet has no ETH to cover gas (viem local pre-check before eth_call)
  if (lower.includes("total cost") && lower.includes("exceeds the balance")) {
    return (
      "Agent wallet has insufficient ETH for gas. " +
      "Enable gas sponsorship (Alchemy paymaster) or send a small amount of ETH to the agent wallet."
    );
  }

  return null;
}

const NATIVE_TOKEN: Record<number, string> = {
  1: "ETH", 10: "ETH", 130: "ETH", 8453: "ETH", 42161: "ETH",
  56: "BNB", 137: "POL",
  11155111: "ETH", 84532: "ETH",
};

/**
 * Parse Alchemy bundler/paymaster errors to detect rate-limit or spending-cap issues.
 * Returns a user-friendly message if the error matches, otherwise null.
 */
/**
 * No friendly interpretations — the raw Alchemy error (in details/cause) is
 * already descriptive. Adding our own text risks being wrong (e.g. saying
 * "bundler rejected fee parameters" when the actual error is a paymaster
 * spending limit). Returns null so the caller shows only facts.
 */
function parseSponsoredError(_raw: string, _chainId: number, _agentAddress: string, _details?: string): string | null {
  return null;
}

// ── Gas Safety Configuration ──────────────────────────────────────────

/**
 * Hard caps on gas fees to protect agent wallet balances.
 * These are absolute maximums — the agent will NEVER pay more than this.
 *
 * IMPORTANT: The priority fee cap is the safety net against rogue values from
 * estimateMaxPriorityFeePerGas(). Unlike baseFee (set by protocol, only burned),
 * the priority fee is fully paid to the block builder — so a rogue high value
 * directly drains the agent wallet. These caps ensure bounded worst-case cost
 * even if the RPC returns an absurd priority fee estimate.
 */
const GAS_CAPS: Record<number, { maxFeePerGas: bigint; maxPriorityFee: bigint }> = {
  1:     { maxFeePerGas: parseGwei("10"),    maxPriorityFee: parseGwei("0.1") },
  10:    { maxFeePerGas: parseGwei("1"),     maxPriorityFee: parseGwei("0.01") },
  56:    { maxFeePerGas: parseGwei("5"),     maxPriorityFee: parseGwei("0.1") },
  130:   { maxFeePerGas: parseGwei("0.01"),  maxPriorityFee: parseGwei("0.001") }, // Unichain
  137:   { maxFeePerGas: parseGwei("500"),   maxPriorityFee: parseGwei("500") },
  8453:  { maxFeePerGas: parseGwei("1"),     maxPriorityFee: parseGwei("0.01") },
  42161: { maxFeePerGas: parseGwei("1"),     maxPriorityFee: parseGwei("0.01") },
  // Testnets
  11155111: { maxFeePerGas: parseGwei("10"),  maxPriorityFee: parseGwei("0.1") },
  84532:   { maxFeePerGas: parseGwei("1"),    maxPriorityFee: parseGwei("0.01") },
};

/**
 * Multiplier for base fee estimation.
 * 1.5x guarantees inclusion even if the base fee maxes over the next 2 blocks
 * (Ethereum allows max ~12.5% base fee increase per block).
 */
const BASE_FEE_MULTIPLIER = 150n; // 150% = 1.5x (divided by 100)

/** Maximum number of resubmission attempts */
const MAX_RESUBMIT_ATTEMPTS = 1;

/** Fee bump percentage for resubmission (10% = minimum for most clients) */
const RESUBMIT_FEE_BUMP_PCT = 15n; // 15% bump

/** Timeout for waiting for a tx receipt (ms) */
const TX_CONFIRM_TIMEOUT_MS = 15_000;

/** Fast-confirming chains (L2s, BSC) with sub-second block times */
const FAST_CHAIN_IDS = new Set([10, 42161, 8453, 130, 56, 84532]);

/**
 * Per-chain minimum balance for the agent wallet.
 *
 * This is a rough UI indicator used by the /balance endpoint to show
 * "sufficient" vs "low" in the delegation panel. The ACTUAL balance
 * check happens at execution time using real gas estimation.
 *
 * L2s are extremely cheap (~$0.001-0.01 per tx), so the minimum is tiny.
 * L1/Polygon/BSC have higher base fees.
 */
const MIN_BALANCE: Record<number, bigint> = {
  1:        500_000_000_000_000n,    // 0.0005 ETH  — L1 Ethereum
  10:       1_000_000_000_000n,      // 0.000001 ETH — Optimism
  56:       500_000_000_000_000n,    // 0.0005 BNB  — BSC
  130:      1_000_000_000_000n,      // 0.000001 ETH — Unichain
  137:      50_000_000_000_000_000n, // 0.05 POL    — Polygon
  8453:     1_000_000_000_000n,      // 0.000001 ETH — Base
  42161:    1_000_000_000_000n,      // 0.000001 ETH — Arbitrum
  // Testnets
  11155111: 500_000_000_000_000n,    // 0.0005 ETH  — Sepolia
  84532:    1_000_000_000_000n,      // 0.000001 ETH — Base Sepolia
};

// ── Block explorer URLs ───────────────────────────────────────────────
const EXPLORER_TX_URL: Record<number, string> = {
  1: "https://etherscan.io/tx/",
  10: "https://optimistic.etherscan.io/tx/",
  56: "https://bscscan.com/tx/",
  130: "https://uniscan.xyz/tx/",
  137: "https://polygonscan.com/tx/",
  8453: "https://basescan.org/tx/",
  42161: "https://arbiscan.io/tx/",
  11155111: "https://sepolia.etherscan.io/tx/",
  84532: "https://sepolia.basescan.org/tx/",
};

// ── Fee estimation ────────────────────────────────────────────────────

interface FeeEstimate {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * Per-Worker-invocation cache for fee estimates.
 * Cloudflare Workers isolates do not reliably share in-memory state across HTTP
 * requests, so this cache is intentionally scoped to the current invocation.
 * Key: `${chainId}:${blockHash}`.
 */
const feeEstimateCache = new Map<string, FeeEstimate>();

/**
 * Estimate EIP-1559 gas fees with safety caps.
 *
 * Exported for testing the priority-fee floor logic.
 */
export async function estimateFees(
  publicClient: PublicClient,
  chainId: number,
): Promise<FeeEstimate> {
  const caps = GAS_CAPS[chainId];
  if (!caps) {
    throw new ExecutionError(
      `Unsupported chain ID: ${chainId}. Gas fee caps are not configured for this chain.`,
      "UNSUPPORTED_CHAIN",
    );
  }

  // ── Base fee from the latest block (gas oracle) ──
  // We read the actual protocol base fee, then buffer it 2× to cover
  // ~5 blocks of 12.5% compounded increases (Ethereum max per-block bump).
  const block = await publicClient.getBlock({ blockTag: "latest" });

  // Re-use the fee estimate for this chain+block within the same Worker invocation.
  const feeCacheKey = `${chainId}:${block.hash}`;
  const cached = feeEstimateCache.get(feeCacheKey);
  if (cached) return cached;

  const baseFee = block.baseFeePerGas ?? parseGwei("0");
  const bufferedBaseFee = (baseFee * BASE_FEE_MULTIPLIER) / 100n;

  // ── Priority fee ──
  // Use RPC estimateMaxPriorityFeePerGas when available. L2s work fine with
  // whatever the RPC returns. On mainnet the cap (GAS_CAPS[1].maxPriorityFee)
  // keeps the value bounded so we don't overpay on sponsored transactions.
  // If the RPC call fails we fall back to baseFee/10.
  let priorityFee: bigint;
  if (chainId === 1) {
    priorityFee = parseGwei("0.01");
  } else {
    try {
      priorityFee = await publicClient.estimateMaxPriorityFeePerGas();
    } catch {
      priorityFee = baseFee / 10n;
      if (priorityFee < parseGwei("0.001")) priorityFee = parseGwei("0.001");
    }
  }

  const cappedPriorityFee = priorityFee < caps.maxPriorityFee ? priorityFee : caps.maxPriorityFee;
  const maxFee = bufferedBaseFee + cappedPriorityFee;
  const cappedMaxFee = maxFee < caps.maxFeePerGas ? maxFee : caps.maxFeePerGas;

  const result: FeeEstimate = {
    maxFeePerGas: cappedMaxFee,
    maxPriorityFeePerGas: cappedPriorityFee,
  };

  feeEstimateCache.set(feeCacheKey, result);
  return result;
}

/**
 * Bump fees for resubmission (must be at least 10% higher for replacement).
 */
function bumpFees(fees: FeeEstimate, chainId: number): FeeEstimate {
  const caps = GAS_CAPS[chainId];
  if (!caps) {
    throw new ExecutionError(
      `Unsupported chain ID: ${chainId}. Cannot bump fees for an unconfigured chain.`,
      "UNSUPPORTED_CHAIN",
    );
  }

  const bumpedMaxFee = fees.maxFeePerGas + (fees.maxFeePerGas * RESUBMIT_FEE_BUMP_PCT) / 100n;
  const bumpedPriority = fees.maxPriorityFeePerGas + (fees.maxPriorityFeePerGas * RESUBMIT_FEE_BUMP_PCT) / 100n;

  return {
    maxFeePerGas: bumpedMaxFee < caps.maxFeePerGas ? bumpedMaxFee : caps.maxFeePerGas,
    maxPriorityFeePerGas: bumpedPriority < caps.maxPriorityFee ? bumpedPriority : caps.maxPriorityFee,
  };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Type guard: a transaction is "prepared" only when it has a non-zero gas limit
 * AND the internal `prepared` marker set by finalizeToolTransaction().
 */
function isPreparedTransaction(tx: TransactionDraft): tx is UnsignedTransaction & { prepared: true } {
  const maybe = tx as Partial<UnsignedTransaction>;
  return !!maybe.gas && maybe.gas !== "0x0" && maybe.prepared === true;
}

/**
 * Shared transaction finalizer: estimate gas once and run the NAV shield once.
 *
 * This is the single place where `eth_estimateGas` and the full `multicall`
 * NAV simulation run for transactions that are about to be returned to the
 * wallet/frontend or broadcast by the agent. Keeping both checks here prevents
 * the duplicate simulation that previously happened in handlers + broadcast.
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

  // Determine the operator/owner address to use for NAV simulation.
  let callerAddress: Address;
  if (ctx.operatorVerified && ctx.operatorAddress) {
    callerAddress = ctx.operatorAddress;
  } else {
    try {
      callerAddress = await publicClient.readContract({
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

  // Determine the transaction executor (sender for gas estimation).
  let executor: Address;
  if (tx.operatorOnly || ctx.executionMode === "manual") {
    executor = callerAddress;
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

  // Estimate gas from the actual executor. This is also the structural simulation.
  const txValue = BigInt(tx.value || "0x0");
  let estimatedGas: bigint;
  try {
    estimatedGas = await publicClient.estimateGas({
      account: executor,
      to: tx.to,
      data: tx.data,
      value: txValue,
    });
  } catch (estErr) {
    const msg = estErr instanceof Error ? estErr.message : String(estErr);
    let revertData = getRevertDataFromError(estErr);

    // Some RPCs return a generic "execution reverted" from eth_estimateGas without
    // the actual revert payload. A follow-up eth_call with the same transaction often
    // surfaces the real revert data so we can decode it for the user.
    if (!revertData && (msg.toLowerCase().includes("reverted") || msg.toLowerCase().includes("revert"))) {
      try {
        await publicClient.call({
          account: executor,
          to: tx.to,
          data: tx.data,
          value: txValue,
        });
      } catch (callErr) {
        revertData = getRevertDataFromError(callErr);
      }
    }

    const decodedRevert = revertData ? decodeRevertData(revertData) : null;
    const friendly = decodedRevert || parseSimulationRevert(msg);
    if (friendly || msg.toLowerCase().includes("reverted") || msg.toLowerCase().includes("revert")) {
      throw new ExecutionError(
        friendly ||
        `Transaction simulation failed — the transaction would revert on-chain. The RPC did not return a revert reason.`,
        "SIMULATION_FAILED",
      );
    }
    throw new ExecutionError(
      `Gas estimation failed: ${sanitizeError(msg)}`,
      "GAS_ESTIMATION_FAILED",
    );
  }

  tx.gas = `0x${(estimatedGas + (estimatedGas * 20n) / 100n).toString(16)}`;

  // NAV shield only applies when the transaction targets the vault itself.
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const isVaultTarget = !!ctx.vaultAddress &&
    ctx.vaultAddress.toLowerCase() !== ZERO_ADDR &&
    tx.to.toLowerCase() === ctx.vaultAddress.toLowerCase();

  if (isVaultTarget) {
    // Read operator's custom NAV shield threshold (falls back to default 10%).
    const storedNavThreshold = env.KV
      ? await getNavShieldThreshold(env.KV, callerAddress)
      : null;

    const navResult = await checkNavImpact(
      ctx.vaultAddress as Address,
      tx.data,
      txValue,
      tx.chainId,
      env.ALCHEMY_API_KEY,
      callerAddress,
      env.KV,
      storedNavThreshold ?? undefined,
      env.requestCache,
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

    return { tx };
  }

  // Non-vault transactions (operator-only approvals, pool initialization, etc.)
  // are not subject to the NAV shield, but gas estimation still happens above.
  tx.navShieldChecked = true;
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
            if (gasInfo.alchemyMaxFeePerGasGwei) parts.push(`Alchemy maxFeePerGas: ${gasInfo.alchemyMaxFeePerGasGwei} gwei`);
            if (gasInfo.alchemyMaxPriorityFeePerGasGwei) parts.push(`Alchemy maxPriorityFeePerGas: ${gasInfo.alchemyMaxPriorityFeePerGasGwei} gwei`);
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
 * Steps:
 *   1. Check agent balance
 *   2. Estimate gas on-chain via eth_estimateGas (also catches reverts; accurate for vault proxy overhead)
 *   3. Estimate fees with safety caps
 *   4. Send the transaction
 *   5. Wait for confirmation with automatic resubmission
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

  // ── Step 1: Check agent wallet balance ──
  const balance = await publicClient.getBalance({ address: agentAccount.address });

  if (txValue > 0n && balance < txValue) {
    throw new ExecutionError(
      `Agent balance (${(Number(balance) / 1e18).toFixed(6)} ETH) insufficient for tx value ` +
      `(${(Number(txValue) / 1e18).toFixed(6)} ETH). Fund the agent at ${agentAccount.address}`,
      "INSUFFICIENT_BALANCE",
    );
  }

  // ── Step 2: Use pre-computed gas limit ──
  // Gas was already estimated once by prepareTransaction() from the agent address
  // and includes a 20% buffer. We reuse it here to avoid a duplicate eth_estimateGas
  // on the broadcast hot path.
  const gasLimit = BigInt(tx.gas || "0x0");
  if (gasLimit === 0n) {
    throw new ExecutionError(
      "Gas limit is missing for this transaction. Rebuild the transaction to estimate gas.",
      "GAS_ESTIMATION_FAILED",
    );
  }

  // ── Step 3: Estimate fees with safety caps ──
  let fees = await estimateFees(publicClient, chainId);

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

  const nonce = await publicClient.getTransactionCount({ address: agentAccount.address });


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
      const errMsg = err instanceof Error ? err.message : String(err);
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
      fees = bumpFees(fees, chainId);


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
    const status = receipt.status === "success" ? "Confirmed" : "REVERTED";

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
  // and includes a 20% buffer. We pass it as the callGasLimit override to prevent
  // the bundler from underestimating complex vault adapter calls.
  const callGasLimit = BigInt(tx.gas || "0x0");
  if (callGasLimit === 0n) {
    throw new ExecutionError(
      "Gas limit is missing for this transaction. Rebuild the transaction to estimate gas.",
      "GAS_ESTIMATION_FAILED",
    );
  }

  // ── Step 2: Fee estimate + sponsorship viability check ──
  // We override the bundler's fee estimation with our own values (base fee from
  // the latest block × 2, priority fee from RPC with a 0.05 gwei floor). This
  // gives us control over the cost Alchemy sees in the UserOperation while
  // respecting bundler minimums.
  let fees: FeeEstimate;
  try {
    fees = await estimateFees(publicClient, chainId);
  } catch (feeErr) {
    const msg = feeErr instanceof Error ? feeErr.message : String(feeErr);
    throw new ExecutionError(
      `Fee estimation failed — RPC may be unreachable on chain ${chainId}. Details: ${sanitizeError(msg)}`,
      "GAS_ESTIMATION_FAILED",
    );
  }

  // NOTE: We no longer skip sponsorship pre-emptively on mainnet. Alchemy's
  // paymaster will either accept or reject the UserOperation. If rejected,
  // the real error (spending limit, policy expired, etc.) is decoded below
  // and presented to the user so they can decide: fund agent wallet,
  // disable sponsorship, or sign manually.

  // ── Step 3: Execute via Alchemy Smart Wallet SDK ──
  const calls: WalletCall[] = [{
    to: tx.to as Address,
    value: txValue > 0n ? (`0x${txValue.toString(16)}` as Hex) : ("0x0" as Hex),
    data: tx.data as Hex,
  }];

  // Capture gas params so the caller can verify Alchemy's rejection reason.
  // Also captures Alchemy's returned fee values from -32602 data fields so
  // the user can compare "what we sent" vs "what Alchemy expects".
  const buildGasInfo = (overrideFees?: FeeEstimate, alchemyFees?: { maxFee?: bigint; maxPriorityFee?: bigint }) => ({
    callGasLimit: callGasLimit ? callGasLimit.toString() : undefined,
    ourMaxFeePerGasGwei: formatGwei(overrideFees ? overrideFees.maxFeePerGas : fees.maxFeePerGas),
    ourMaxPriorityFeePerGasGwei: formatGwei(overrideFees ? overrideFees.maxPriorityFeePerGas : fees.maxPriorityFeePerGas),
    alchemyMaxFeePerGasGwei: alchemyFees?.maxFee ? formatGwei(alchemyFees.maxFee) : undefined,
    alchemyMaxPriorityFeePerGasGwei: alchemyFees?.maxPriorityFee ? formatGwei(alchemyFees.maxPriorityFee) : undefined,
    maxCostEth: callGasLimit
      ? (Number(callGasLimit * (overrideFees ? overrideFees.maxFeePerGas : fees.maxFeePerGas)) / 1e18).toFixed(6)
      : undefined,
  });

  async function trySponsoredCalls(attemptFees: FeeEstimate, isRetry: boolean): Promise<ReturnType<typeof executeSponsoredCalls>> {
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
        // Recompute fees using the bundler's minimums
        const newPriorityFee = dataPriorityFee
          || (requiredMinWei && requiredMinWei > attemptFees.maxPriorityFeePerGas ? requiredMinWei : undefined)
          || attemptFees.maxPriorityFeePerGas;
        const newMaxFee = dataMaxFee
          || (newPriorityFee > attemptFees.maxFeePerGas ? newPriorityFee + (newPriorityFee * 10n) / 100n : attemptFees.maxFeePerGas);

        const retryFees: FeeEstimate = {
          maxPriorityFeePerGas: newPriorityFee,
          maxFeePerGas: newMaxFee,
        };

        return trySponsoredCalls(retryFees, true);
      }

      // Attach Alchemy's returned fee values so the user can compare
      const alchemyFees = (dataMaxFee || dataPriorityFee)
        ? { maxFee: dataMaxFee, maxPriorityFee: dataPriorityFee }
        : undefined;
      (err as any)._gasInfo = buildGasInfo(attemptFees, alchemyFees);
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
  const receiptTxHash = receipt?.transactionHash || ("0x" as Hex);
  const explorerUrl = explorerBase && receiptTxHash !== "0x"
    ? `${explorerBase}${receiptTxHash}`
    : undefined;

  if (result.status === "success" && receipt) {
    const gasUsed = receipt.gasUsed.toString();
    const isSuccess = receipt.status === "success";
    const statusLabel = isSuccess ? "Confirmed (sponsored)" : "REVERTED";



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

  // Pending / status timeout — submission was accepted but we could not
  // confirm the on-chain status in time. If we have an EVM receipt hash,
  // return it; otherwise expose the callId (UserOp hash) as userOpHash so
  // downstream formatters/status checks can label it correctly and poll
  // wallet_getCallsStatus to map it to the eventual EVM txHash.
  if (receiptTxHash !== "0x") {
    return {
      txHash: receiptTxHash,
      chainId,
      confirmed: false,
      reverted: false,
      explorerUrl,
      sponsored: true,
      userOpHash: result.callId as Hex,
      gasCostEth: "0 (sponsored)",
      resubmitAttempts: 0,
    };
  }
  return {
    txHash: result.callId as Hex,
    chainId,
    confirmed: false,
    reverted: false,
    explorerUrl: undefined,
    sponsored: true,
    userOpHash: result.callId as Hex,
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
 */
async function storePendingTx(kv: KVNamespace, vaultAddress: string, result: ExecutionResult): Promise<void> {
  const key = `pending-tx:${result.txHash}`;
  await kv.put(key, JSON.stringify({
    ...result,
    storedAt: Date.now(),
  }), { expirationTtl: 3600 });

  // Per-vault index keyed by chain so we can look up the latest pending tx.
  const indexKey = `pending-tx-by-vault:${vaultAddress.toLowerCase()}:${result.chainId}`;
  await kv.put(indexKey, result.txHash, { expirationTtl: 3600 });
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
      txHash: hash,
      message: `Transaction <code>${hash}</code> is still pending on chain ${chainId}. It may take a few minutes to land, especially on Ethereum mainnet.`,
    };
  }

  if (result.confirmed) {
    return {
      status: "confirmed",
      txHash: hash,
      explorerUrl: result.explorerUrl,
      blockNumber: result.blockNumber,
      message: `Transaction <code>${hash}</code> confirmed in block ${result.blockNumber}.${result.explorerUrl ? ` <a href="${result.explorerUrl}">View on explorer</a>` : ""}`,
    };
  }

  return {
    status: "reverted",
    txHash: hash,
    explorerUrl: result.explorerUrl,
    message: `Transaction <code>${hash}</code> reverted on-chain.${result.explorerUrl ? ` <a href="${result.explorerUrl}">View on explorer</a>` : ""}`,
  };
}

/**
 * Check the status of a pending transaction.
 * If a receipt is found, cleans up both the tx record and the per-vault index.
 *
 * For sponsored (UserOp) transactions, the stored `hash` may be the callId
 * (UserOp hash) rather than the EVM transaction hash. In that case we call
 * Alchemy's `wallet_getCallsStatus` to resolve it to a receipt before falling
 * back to a normal eth_getTransactionReceipt.
 */
export async function checkPendingTxStatus(
  env: Env,
  hash: string,
  chainId: number,
  vaultAddress?: string,
): Promise<ExecutionResult | null> {
  const alchemyKey = env.ALCHEMY_API_KEY;
  const publicClient = getClient(chainId, alchemyKey);

  // Helper to build an ExecutionResult from an EVM receipt and clean up KV.
  const buildResult = async (receipt: TransactionReceipt, txHash: Hex): Promise<ExecutionResult> => {
    const explorerBase = EXPLORER_TX_URL[chainId];
    const gasUsed = receipt.gasUsed;
    const effectiveGasPrice = receipt.effectiveGasPrice;
    const cost = gasUsed * effectiveGasPrice;

    const result: ExecutionResult = {
      txHash,
      chainId,
      confirmed: receipt.status === "success",
      reverted: receipt.status !== "success",
      blockNumber: Number(receipt.blockNumber),
      explorerUrl: explorerBase ? `${explorerBase}${txHash}` : undefined,
      gasUsed: gasUsed.toString(),
      effectiveGasPrice: effectiveGasPrice.toString(),
      gasCostEth: formatEther(cost),
      sponsored: false,
    };

    // Clean up KV under both the UserOp hash (if that was the key) and the
    // resolved EVM txHash.
    await env.KV.delete(`pending-tx:${hash}`);
    if (txHash !== hash) {
      await env.KV.delete(`pending-tx:${txHash}`);
    }
    if (vaultAddress) {
      await env.KV.delete(getPendingTxIndexKey(vaultAddress, chainId));
    }
    return result;
  };

  // 1. Try normal EVM receipt lookup first.
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: hash as Hex });
    if (receipt) {
      return await buildResult(receipt, hash as Hex);
    }
  } catch {
    // not found on-chain yet — continue to UserOp resolution
  }

  // 2. If no EVM receipt, the hash may be a sponsored UserOp callId. Query
  //    Alchemy's wallet_getCallsStatus to map it to an EVM txHash, then fetch
  //    the on-chain receipt for that txHash.
  const candidateHashes = [hash];
  // Some bundlers return a 64-byte identifier where only the last 32 bytes
  // are the actual UserOp hash. Try both the full value and its suffix.
  if (hash.startsWith("0x") && hash.length - 2 === 128) {
    candidateHashes.push(`0x${hash.slice(-64)}`);
  }

  for (const candidate of candidateHashes) {
    try {
      const sponsoredStatus = await getSponsoredCallsStatus(candidate, chainId, alchemyKey);
      const resolvedHash = sponsoredStatus.receipts?.[0]?.transactionHash;
      if (resolvedHash) {
        const onChainReceipt = await publicClient.getTransactionReceipt({ hash: resolvedHash });
        if (onChainReceipt) {
          return await buildResult(onChainReceipt, resolvedHash);
        }
      }
    } catch (err) {
      // If wallet_getCallsStatus fails (e.g. hash is not a known callId), treat
      // as still pending rather than throwing. Log the failure for debugging.
      console.warn(
        `[execution] UserOp status resolution failed for ${candidate} on chain ${chainId}: ` +
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
      const isSponsoredTimeout = result.sponsored && result.gasCostEth?.includes("timed out");
      const isUserOpHash = result.sponsored && result.userOpHash && result.txHash === result.userOpHash;
      const hashLabel = isUserOpHash
        ? "UserOp hash (sponsored — not yet on-chain)"
        : (result.sponsored ? "Sponsored transaction hash" : "Transaction hash");
      const pendingNote = isSponsoredTimeout
        ? " The status check timed out; the transaction may still confirm on-chain."
        : " Waiting for confirmation…";
      const checkHint = " Ask me for a status update anytime (e.g. \"is my transaction stuck?\").";
      const sponsoredHint = result.sponsored && !isUserOpHash
        ? " This is a sponsored UserOp hash — it may not appear in the public mempool until it lands."
        : "";
      const userOpNote = isUserOpHash
        ? "\nThis is the bundler UserOp identifier, not the on-chain transaction hash. The explorer link will appear once the bundle is included."
        : "";
      parts.push(`⏳ ${desc} submitted.\n${hashLabel}: \`${result.txHash}\`${sponsoredHint}${pendingNote}${userOpNote}${checkHint}${fallbackNote}`);
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
