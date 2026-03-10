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
  createPublicClient,
  createWalletClient,
  http,
  formatGwei,
  formatEther,
  parseGwei,
  type Address,
  type Hex,
  type TransactionReceipt,
  type Chain,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { Env, UnsignedTransaction, ExecutionResult } from "../types.js";
import { getChain, getRpcUrl } from "../config.js";
import { loadAgentWalletAccount } from "./agentWallet.js";
import { getDelegationConfig, getChainDelegation } from "./delegation.js";
import {
  executeSponsoredCalls,
  type WalletCall,
} from "./bundler.js";
import { checkNavImpact } from "./navGuard.js";

const ALCHEMY_ORIGIN = "https://trader.rigoblock.com";

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
  // L1 Ethereum — 0.1 gwei priority cap to avoid wallet drain from rogue RPC values
  1:     { maxFeePerGas: parseGwei("50"),  maxPriorityFee: parseGwei("0.1") },
  // L2s — much cheaper, priority is negligible
  10:    { maxFeePerGas: parseGwei("1"),   maxPriorityFee: parseGwei("0.01") },
  // BSC — same conservative priority as L1
  56:    { maxFeePerGas: parseGwei("5"),   maxPriorityFee: parseGwei("0.1") },
  // Polygon — high base fees (market ~290 gwei priority), cap at 500 to cover spikes
  137:   { maxFeePerGas: parseGwei("500"), maxPriorityFee: parseGwei("500") },
  8453:  { maxFeePerGas: parseGwei("1"),   maxPriorityFee: parseGwei("0.01") },
  42161: { maxFeePerGas: parseGwei("1"),   maxPriorityFee: parseGwei("0.01") },
  // Testnets
  11155111: { maxFeePerGas: parseGwei("50"),  maxPriorityFee: parseGwei("0.1") },
  84532:   { maxFeePerGas: parseGwei("1"),    maxPriorityFee: parseGwei("0.01") },
};

/** Default caps for chains not explicitly listed */
const DEFAULT_GAS_CAP = { maxFeePerGas: parseGwei("30"), maxPriorityFee: parseGwei("0.1") };

/**
 * Multiplier for base fee estimation.
 * 2x guarantees inclusion even if the base fee doubles over the next 2 blocks
 * (Ethereum allows max ~12.5% base fee increase per block).
 * A 1.25x buffer would fail to land txs during base fee spikes.
 */
const BASE_FEE_MULTIPLIER = 200n; // 200% = 2x (divided by 100)

/** Maximum number of resubmission attempts */
const MAX_RESUBMIT_ATTEMPTS = 2;

/** Blocks to wait before considering resubmission */
const RESUBMIT_AFTER_BLOCKS = 2;

/** Fee bump percentage for resubmission (10% = minimum for most clients) */
const RESUBMIT_FEE_BUMP_PCT = 15n; // 15% bump

/** Timeout for waiting for a tx receipt (ms) */
const TX_CONFIRM_TIMEOUT_MS = 30_000;

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
  1:     500_000_000_000_000n,     // 0.0005 ETH  — L1 Ethereum
  56:    500_000_000_000_000n,     // 0.0005 BNB  — BSC
  137:   50_000_000_000_000_000n,   // 0.05 POL    — Polygon
};
/** L2 default: 0.000001 ETH (~$0.003) — covers several L2 transactions */
const DEFAULT_MIN_BALANCE = 1_000_000_000_000n;

// ── Block explorer URLs ───────────────────────────────────────────────
const EXPLORER_TX_URL: Record<number, string> = {
  1: "https://etherscan.io/tx/",
  10: "https://optimistic.etherscan.io/tx/",
  56: "https://bscscan.com/tx/",
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
 * Estimate EIP-1559 gas fees with safety caps.
 */
async function estimateFees(
  publicClient: ReturnType<typeof createPublicClient>,
  chainId: number,
): Promise<FeeEstimate> {
  const caps = GAS_CAPS[chainId] || DEFAULT_GAS_CAP;

  const block = await publicClient.getBlock({ blockTag: "latest" });
  const baseFee = block.baseFeePerGas ?? parseGwei("1");

  const bufferedBaseFee = (baseFee * BASE_FEE_MULTIPLIER) / 100n;

  let priorityFee: bigint;
  try {
    priorityFee = await publicClient.estimateMaxPriorityFeePerGas();
  } catch {
    priorityFee = baseFee / 10n;
    if (priorityFee < parseGwei("0.001")) priorityFee = parseGwei("0.001");
  }

  const cappedPriorityFee = priorityFee < caps.maxPriorityFee ? priorityFee : caps.maxPriorityFee;
  const maxFee = bufferedBaseFee + cappedPriorityFee;
  const cappedMaxFee = maxFee < caps.maxFeePerGas ? maxFee : caps.maxFeePerGas;

  console.log(
    `[Gas] Chain ${chainId}: baseFee=${formatGwei(baseFee)} gwei, ` +
    `buffered=${formatGwei(bufferedBaseFee)} gwei, ` +
    `priority=${formatGwei(cappedPriorityFee)} gwei, ` +
    `maxFee=${formatGwei(cappedMaxFee)} gwei ` +
    `(cap: ${formatGwei(caps.maxFeePerGas)} gwei)`,
  );

  return {
    maxFeePerGas: cappedMaxFee,
    maxPriorityFeePerGas: cappedPriorityFee,
  };
}

/**
 * Bump fees for resubmission (must be at least 10% higher for replacement).
 */
function bumpFees(fees: FeeEstimate, chainId: number): FeeEstimate {
  const caps = GAS_CAPS[chainId] || DEFAULT_GAS_CAP;

  const bumpedMaxFee = fees.maxFeePerGas + (fees.maxFeePerGas * RESUBMIT_FEE_BUMP_PCT) / 100n;
  const bumpedPriority = fees.maxPriorityFeePerGas + (fees.maxPriorityFeePerGas * RESUBMIT_FEE_BUMP_PCT) / 100n;

  return {
    maxFeePerGas: bumpedMaxFee < caps.maxFeePerGas ? bumpedMaxFee : caps.maxFeePerGas,
    maxPriorityFeePerGas: bumpedPriority < caps.maxPriorityFee ? bumpedPriority : caps.maxPriorityFee,
  };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Execute a transaction via the agent wallet.
 *
 * The agent sends the transaction directly to the vault contract.
 * The vault validates the agent is authorized via its delegation mapping.
 *
 * Safety checks:
 * 1. Delegation config exists and is enabled
 * 2. Transaction target is the delegated vault
 * 3. Function selector is in the allowed set
 * 4. Agent wallet exists and matches config
 * 5. Transaction simulation passes (eth_call)
 * 6. Agent has sufficient ETH for gas
 * 7. Gas fees are within hard caps
 */
export async function executeViaDelegation(
  env: Env,
  tx: UnsignedTransaction,
  vaultAddress: string,
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
  const chainDelegation = await getChainDelegation(env.KV, vaultAddress, tx.chainId);
  if (!chainDelegation) {
    throw new ExecutionError(
      `Delegation not active on chain ${tx.chainId}. Set up delegation on this chain first.`,
      "DELEGATION_NOT_ON_CHAIN",
    );
  }

  // 3. Verify the transaction target is the vault
  if (tx.to.toLowerCase() !== vaultAddress.toLowerCase()) {
    throw new ExecutionError(
      `Transaction target ${tx.to} is not the vault ${vaultAddress}. ` +
      `The agent can only send transactions to the delegated vault.`,
      "TARGET_NOT_ALLOWED",
    );
  }

  // 4. Verify the function selector is allowed
  const selector = tx.data.slice(0, 10) as Hex;
  const allowedSelectors = chainDelegation.delegatedSelectors.map((s) => s.toLowerCase());
  if (!allowedSelectors.includes(selector.toLowerCase())) {
    throw new ExecutionError(
      `Function selector ${selector} is not in the delegated selectors for chain ${tx.chainId}`,
      "METHOD_NOT_ALLOWED",
    );
  }

  // 5. Load the agent wallet
  const agentAccount = await loadAgentWalletAccount(
    env.KV,
    vaultAddress,
    env.AGENT_WALLET_SECRET,
  );
  if (!agentAccount) {
    throw new ExecutionError(
      "Agent wallet not found for this vault",
      "AGENT_WALLET_NOT_FOUND",
    );
  }

  // 6. Verify agent address matches config
  if (agentAccount.address.toLowerCase() !== config.agentAddress.toLowerCase()) {
    throw new ExecutionError(
      "Agent wallet address mismatch with delegation config",
      "AGENT_WALLET_MISMATCH",
    );
  }

  // 6b. NAV Guard — prevent trades that crash the pool's unit price
  // Runs BEFORE execution (both sponsored & direct paths).
  // Simulates a multicall([swap, getNavDataView]) to measure post-swap NAV impact.
  // IMPORTANT: This guard is selector-agnostic — it runs on ANY function call
  // the agent sends to the vault (swaps, GMX, depositV3, future methods).
  // No per-method extension is needed when new vault adapters are added.
  try {
    const navResult = await checkNavImpact(
      tx.to as Address,
      tx.data as Hex,
      BigInt(tx.value),
      tx.chainId,
      env.ALCHEMY_API_KEY,
      agentAccount.address,
      env.KV,
    );
    if (!navResult.allowed) {
      console.warn(
        `[executeViaDelegation] NAV guard BLOCKED tx: ${navResult.reason}`,
      );
      throw new ExecutionError(
        navResult.reason || "Trade blocked by NAV protection — would reduce unit price too much",
        "NAV_GUARD_BLOCKED",
      );
    }
    if (navResult.dropPct !== "0" && navResult.dropPct !== "0.00") {
      console.log(
        `[executeViaDelegation] NAV guard OK: drop=${navResult.dropPct}% ` +
        `(pre=${navResult.preNavUnitaryValue} post=${navResult.postNavUnitaryValue})`,
      );
    }
  } catch (err) {
    // If it's our own NAV_GUARD_BLOCKED error, re-throw
    if (err instanceof ExecutionError && err.code === "NAV_GUARD_BLOCKED") {
      throw err;
    }
    // For any other error (RPC issues, etc.), log and continue — don't block execution
    console.warn(`[executeViaDelegation] NAV guard error (non-blocking): ${err}`);
  }

  // 7. Execute the transaction
  // Choose execution path: sponsored (ERC-4337 bundler) or direct broadcast
  const useSponsored = config.sponsoredGas && !!env.ALCHEMY_GAS_POLICY_ID;
  console.log(`[executeViaDelegation] Path: ${useSponsored ? 'SPONSORED' : 'DIRECT'}, ` +
    `sponsoredGas=${config.sponsoredGas}, policyId=${env.ALCHEMY_GAS_POLICY_ID ? 'SET' : 'MISSING'}, ` +
    `agent=${agentAccount.address}, chain=${tx.chainId}`);

  let result: ExecutionResult;

  if (useSponsored) {
    // ── Sponsored path: submit as UserOperation via Alchemy bundler ──
    // The paymaster sponsors gas, so the agent wallet doesn't need ETH.
    // The agent EOA must have EIP-7702 authorization (auto-set on first use).
    console.log(`[executeViaDelegation] Calling sponsoredAgentTransaction...`);
    result = await sponsoredAgentTransaction(
      agentAccount,
      tx,
      tx.chainId,
      env.ALCHEMY_API_KEY,
      env.ALCHEMY_GAS_POLICY_ID!,
      env.KV,
    );
  } else {
    // ── Direct broadcast: agent wallet pays gas ──
    result = await broadcastAgentTransaction(
      agentAccount,
      tx,
      tx.chainId,
      env.ALCHEMY_API_KEY,
    );
  }

  // Store pending tx in KV for async monitoring (if not yet confirmed)
  if (!result.confirmed) {
    await storePendingTx(env.KV, result);
  }

  return result;
}

/**
 * Broadcast a transaction from the agent wallet directly to the vault.
 *
 * Steps:
 *   1. Simulate the transaction via eth_call (catches reverts before spending gas)
 *   2. Check agent balance
 *   3. Estimate gas on-chain via eth_estimateGas (accurate for vault proxy overhead)
 *   4. Estimate fees with safety caps
 *   5. Send the transaction
 *   6. Wait for confirmation with automatic resubmission
 */
async function broadcastAgentTransaction(
  agentAccount: PrivateKeyAccount,
  tx: UnsignedTransaction,
  chainId: number,
  alchemyKey?: string,
): Promise<ExecutionResult> {
  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId, alchemyKey);

  const transport = http(rpcUrl, rpcUrl?.includes("alchemy.com")
    ? { fetchOptions: { headers: { Origin: ALCHEMY_ORIGIN } } }
    : undefined,
  );

  const publicClient = createPublicClient({ chain, transport });
  const txValue = BigInt(tx.value);

  // ── Step 1: Simulate the transaction ──
  // This catches reverts BEFORE broadcasting, preventing wasted gas.
  // The vault's delegation check is also validated here.
  try {
    await publicClient.call({
      account: agentAccount.address,
      to: tx.to as Address,
      data: tx.data as Hex,
      value: txValue,
    });
    console.log(`[Execution] Simulation passed for ${tx.to} selector=${tx.data.slice(0, 10)} on chain ${chainId}`);
  } catch (simError) {
    const msg = simError instanceof Error ? simError.message : String(simError);
    console.error(`[Execution] Simulation FAILED for ${tx.to} on chain ${chainId}:`, msg);
    throw new ExecutionError(
      `Transaction simulation failed — the transaction would revert on-chain. ` +
      `This could mean the agent is not delegated on the vault, or the trade parameters are invalid. ` +
      `Details: ${msg}`,
      "SIMULATION_FAILED",
    );
  }

  // ── Step 2: Check agent wallet balance ──
  const balance = await publicClient.getBalance({ address: agentAccount.address });

  if (txValue > 0n && balance < txValue) {
    throw new ExecutionError(
      `Agent balance (${(Number(balance) / 1e18).toFixed(6)} ETH) insufficient for tx value ` +
      `(${(Number(txValue) / 1e18).toFixed(6)} ETH). Fund the agent at ${agentAccount.address}`,
      "INSUFFICIENT_BALANCE",
    );
  }

  // ── Step 3: Estimate gas on-chain ──
  // CRITICAL: tx.gas comes from DEX APIs (0x, Uniswap, GMX) which estimate gas
  // for a direct user transaction. The RigoBlock vault proxy adds 100-200k+ gas
  // overhead for adapter routing. We MUST estimate on-chain to get accurate gas.
  let estimatedGas: bigint;
  try {
    estimatedGas = await publicClient.estimateGas({
      account: agentAccount.address,
      to: tx.to as Address,
      data: tx.data as Hex,
      value: txValue,
    });
    console.log(`[Execution] On-chain gas estimate: ${estimatedGas}`);
  } catch (estError) {
    const msg = estError instanceof Error ? estError.message : String(estError);
    console.error(`[Execution] Gas estimation failed: ${msg}`);
    throw new ExecutionError(
      `Gas estimation failed — the transaction may revert or the RPC is unreachable. Details: ${msg}`,
      "GAS_ESTIMATION_FAILED",
    );
  }
  // 20% buffer over the on-chain estimate for execution variance
  const gasLimit = estimatedGas + (estimatedGas * 20n) / 100n;

  // ── Step 4: Estimate fees with safety caps ──
  let fees = await estimateFees(publicClient, chainId);

  const estimatedCost = (gasLimit * fees.maxFeePerGas) + txValue;
  if (balance < estimatedCost) {
    const needed = Number(estimatedCost) / 1e18;
    const have = Number(balance) / 1e18;
    throw new ExecutionError(
      `Agent balance too low for this transaction. ` +
      `Have: ${have.toFixed(6)} ETH, need: ~${needed.toFixed(6)} ETH ` +
      `(gas: ${gasLimit} × ${formatGwei(fees.maxFeePerGas)} gwei). ` +
      `Send ${(needed - have).toFixed(6)} ETH to ${agentAccount.address}`,
      "INSUFFICIENT_BALANCE",
    );
  }

  // ── Step 5: Send the transaction ──
  const walletClient = createWalletClient({
    account: agentAccount,
    chain,
    transport,
  });

  const nonce = await publicClient.getTransactionCount({ address: agentAccount.address });

  console.log(`[Execution] Broadcasting tx on chain ${chainId}`);
  console.log(`[Execution] Agent: ${agentAccount.address} → Vault: ${tx.to}`);
  console.log(`[Execution] Gas: ${gasLimit}, maxFee: ${formatGwei(fees.maxFeePerGas)} gwei, priority: ${formatGwei(fees.maxPriorityFeePerGas)} gwei`);

  let txHash = await walletClient.sendTransaction({
    to: tx.to as Address,
    data: tx.data as Hex,
    value: txValue,
    gas: gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    nonce,
  });

  console.log(`[Execution] Tx sent: ${txHash}`);

  // ── Step 6: Wait for confirmation with resubmission ──
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
        console.warn(`[Execution] Max resubmission attempts reached for ${txHash}`);
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
      console.log(
        `[Execution] Resubmitting (attempt ${attempt}/${MAX_RESUBMIT_ATTEMPTS}) ` +
        `with bumped fees: maxFee=${formatGwei(fees.maxFeePerGas)} gwei, ` +
        `priority=${formatGwei(fees.maxPriorityFeePerGas)} gwei`,
      );

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
        console.log(`[Execution] Replacement tx sent: ${txHash}`);
      } catch (resubmitErr) {
        console.warn(`[Execution] Resubmission failed: ${resubmitErr}`);
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
    console.log(
      `[Execution] ${status}: block=${receipt.blockNumber} gasUsed=${gasUsed} ` +
      `effectivePrice=${formatGwei(receipt.effectiveGasPrice)} gwei cost=${gasCostEth} ETH`,
    );
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
 *   1. Simulate the vault call (catches reverts before submission)
 *   2. Call executeSponsoredCalls() — one function, handles everything
 *   3. Map the result to ExecutionResult
 */
async function sponsoredAgentTransaction(
  agentAccount: PrivateKeyAccount,
  tx: UnsignedTransaction,
  chainId: number,
  alchemyKey: string,
  gasPolicyId: string,
  _kv: KVNamespace,
): Promise<ExecutionResult> {
  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId, alchemyKey);
  if (!rpcUrl) {
    throw new ExecutionError(
      `No Alchemy RPC available for chain ${chainId} — sponsored execution requires Alchemy`,
      "RPC_UNAVAILABLE",
    );
  }
  const transport = http(rpcUrl, { fetchOptions: { headers: { Origin: ALCHEMY_ORIGIN } } });
  const publicClient = createPublicClient({ chain, transport });
  const txValue = BigInt(tx.value);

  // ── Step 1: Simulate the vault call ──
  try {
    await publicClient.call({
      account: agentAccount.address,
      to: tx.to as Address,
      data: tx.data as Hex,
      value: txValue,
    });
    console.log(`[Sponsored] Simulation passed for ${tx.to} selector=${tx.data.slice(0, 10)} on chain ${chainId}`);
  } catch (simError) {
    const msg = simError instanceof Error ? simError.message : String(simError);
    console.error(`[Sponsored] Simulation FAILED on chain ${chainId}:`, msg);
    throw new ExecutionError(
      `Transaction simulation failed — would revert on-chain. Details: ${msg}`,
      "SIMULATION_FAILED",
    );
  }

  // ── Step 2: Execute via Alchemy Smart Wallet SDK ──
  const calls: WalletCall[] = [{
    to: tx.to as Address,
    value: txValue > 0n ? (`0x${txValue.toString(16)}` as Hex) : ("0x0" as Hex),
    data: tx.data as Hex,
  }];

  console.log(`[Sponsored] Calling executeSponsoredCalls: to=${calls[0].to} value=${calls[0].value} data=${calls[0].data?.slice(0,10)}`);

  const result = await executeSponsoredCalls(
    agentAccount,
    chainId,
    alchemyKey,
    gasPolicyId,
    calls,
  );

  // ── Step 3: Map result to ExecutionResult ──
  const explorerBase = EXPLORER_TX_URL[chainId];
  const receipt = result.receipts?.[0];
  const receiptTxHash = receipt?.transactionHash || ("0x" as Hex);
  const explorerUrl = explorerBase && receiptTxHash !== "0x"
    ? `${explorerBase}${receiptTxHash}`
    : undefined;

  if (result.status === "success" && receipt) {
    const gasUsed = receipt.gasUsed.toString();
    const isSuccess = receipt.status === "success";
    const statusLabel = isSuccess ? "Confirmed (sponsored)" : "REVERTED";

    console.log(
      `[Sponsored] ${statusLabel}: gasUsed=${gasUsed} (sponsored — operator pays $0)`,
    );

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
    throw new ExecutionError(
      `Sponsored execution failed. The transaction may have been rejected by the bundler or paymaster.`,
      "SPONSORED_FAILED",
    );
  }

  // Timeout / pending — submission was accepted but not yet mined
  console.warn(`[Sponsored] Call ${result.callId} not confirmed yet`);
  return {
    txHash: receiptTxHash,
    chainId,
    confirmed: false,
    explorerUrl,
    sponsored: true,
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
  agentAccount: PrivateKeyAccount,
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

  console.log(`[7702] Revoked authorization for ${agentAccount.address} on chain ${chainId}: ${txHash}`);
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
    env.AGENT_WALLET_SECRET,
  );
  if (!agentAccount) {
    throw new ExecutionError("Agent wallet not found", "AGENT_WALLET_NOT_FOUND");
  }

  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId, env.ALCHEMY_API_KEY);
  const transport = http(rpcUrl, rpcUrl?.includes("alchemy.com")
    ? { fetchOptions: { headers: { Origin: ALCHEMY_ORIGIN } } }
    : undefined,
  );
  const client = createPublicClient({ chain, transport });

  const balance = await client.getBalance({ address: agentAccount.address });
  const minBal = MIN_BALANCE[chainId] ?? DEFAULT_MIN_BALANCE;

  return {
    address: agentAccount.address,
    balance,
    sufficient: balance >= minBal,
  };
}

// ── Pending tx tracking ───────────────────────────────────────────────

/**
 * Store a pending (unconfirmed) transaction in KV for async monitoring.
 */
async function storePendingTx(kv: KVNamespace, result: ExecutionResult): Promise<void> {
  const key = `pending-tx:${result.txHash}`;
  await kv.put(key, JSON.stringify({
    ...result,
    storedAt: Date.now(),
  }), { expirationTtl: 3600 });
}

/**
 * Check the status of a pending transaction.
 */
export async function checkPendingTxStatus(
  env: Env,
  hash: string,
  chainId: number,
): Promise<ExecutionResult | null> {
  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId, env.ALCHEMY_API_KEY);

  if (!rpcUrl) {
    throw new ExecutionError("RPC URL not available for chain " + chainId, "RPC_UNAVAILABLE");
  }

  const transport = http(rpcUrl, rpcUrl.includes("alchemy.com")
    ? { fetchOptions: { headers: { Origin: ALCHEMY_ORIGIN } } }
    : undefined,
  );
  const publicClient = createPublicClient({ chain, transport });

  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: hash as Hex });
    if (!receipt) return null;

    const explorerBase = EXPLORER_TX_URL[chainId];
    const gasUsed = receipt.gasUsed;
    const effectiveGasPrice = receipt.effectiveGasPrice;
    const cost = gasUsed * effectiveGasPrice;

    const result: ExecutionResult = {
      txHash: hash as Hex,
      chainId,
      confirmed: receipt.status === "success",
      reverted: receipt.status !== "success",
      blockNumber: Number(receipt.blockNumber),
      explorerUrl: explorerBase ? `${explorerBase}${hash}` : undefined,
      gasUsed: gasUsed.toString(),
      effectiveGasPrice: effectiveGasPrice.toString(),
      gasCostEth: formatEther(cost),
      sponsored: false,
    };

    // Clean up KV
    await env.KV.delete(`pending-tx:${hash}`);
    return result;
  } catch {
    return null;
  }
}

/**
 * Custom error with error code for the API.
 */
export class ExecutionError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
  }
}
