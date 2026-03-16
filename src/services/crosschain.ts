/**
 * Cross-chain transfer, sync & rebalancing service.
 *
 * Uses the AIntents adapter + Across Protocol for cross-chain operations:
 *   Transfer — moves tokens from source vault to destination vault,
 *              burning virtual supply on source, minting via donate on dest.
 *   Sync    — validates NAV impact across chains without moving tokens.
 *
 * Also provides multi-chain aggregated NAV reading and rebalancing
 * recommendations that minimise the number of bridge operations.
 *
 * ## NAV Guard
 * The existing NAV guard in execution.ts (`checkNavImpact`) runs on ALL
 * delegated transactions regardless of function selector. It simulates
 * `multicall([txData, getNavDataView])` via eth_call and rejects if
 * the unitary value drops >10%. This automatically covers `depositV3`
 * and any future vault methods — no per-method extension needed.
 *
 * ## Decimals
 * Token decimals vary across chains (BSC USDC/USDT are 18 vs 6 elsewhere).
 * All amounts are normalised through `applyBscDecimalConversion` before
 * hitting the Across API, and converted back for display.  The Across API
 * itself also validates amounts.
 *
 * @see https://github.com/RigoBlock/v3-contracts/blob/master/contracts/protocol/extensions/adapters/AIntents.sol
 */

import {
  createPublicClient,
  http,
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { ACROSS_SPOKE_POOL_ABI } from "../abi/aIntents.js";
import { getChain, getRpcUrl } from "../config.js";
import {
  OpType,
  ACROSS_SPOKE_POOL,
  CROSSCHAIN_TOKENS,
  findBridgeableToken,
  getOutputToken,
  applyBscDecimalConversion,
  getAcrossHandler,
  type BridgeableToken,
  type BridgeableTokenType,
} from "./crosschainConfig.js";
import { getVaultTokenBalance, getNavData, getPoolData } from "./vault.js";
import { getDelegationConfig, getActiveChains } from "./delegation.js";
import type { DelegationConfig } from "../types.js";

// ── Constants ─────────────────────────────────────────────────────────

const ALCHEMY_ORIGIN = "https://trader.rigoblock.com";

/** Maximum bridge fee as bps (2% — hard-coded in AIntents.sol as MAX_BRIDGE_FEE_BPS) */
const MAX_BRIDGE_FEE_BPS = 200;

/** Default fill deadline window: 6 hours from quote timestamp */
const DEFAULT_FILL_DEADLINE_SECS = 6 * 60 * 60; // 21 600

/** Default NAV tolerance for Sync ops (100 bps = 1%) */
const DEFAULT_NAV_TOLERANCE_BPS = 100;

/** Across suggested-fees API base URL */
const ACROSS_API = "https://app.across.to/api/suggested-fees";

/**
 * Minimum sync amount per token type (human-readable).
 * This covers Across relay fees with comfortable margin.
 * For Sync, amount should be small — just enough to carry the message.
 */
const MIN_SYNC_AMOUNTS: Record<BridgeableTokenType, string> = {
  USDC: "2",      // $2 covers gas relay fees on all routes
  USDT: "2",
  WETH: "0.001",  // ~$3-4 at typical ETH prices
  WBTC: "0.0001", // ~$6-10
};

// ── Types ─────────────────────────────────────────────────────────────

export interface AcrossFeeQuote {
  /** Total relay fee in token units (absolute, not pct) */
  totalRelayFeeRaw: bigint;
  /** Total fee as percentage (18-decimal pct string from API) */
  totalRelayFeePct: string;
  /** Estimated fill time in seconds */
  estimatedFillTimeSec: number;
  /** Quote timestamp to use in depositV3 */
  quoteTimestamp: number;
  /** Exclusive relayer (address(0) for open competition) */
  exclusiveRelayer: Address;
  /** Exclusivity deadline (0 for open) */
  exclusivityDeadline: number;
  /** Source spoke pool address */
  spokePoolAddress: Address;
  /** Whether the amount is too low for Across */
  isAmountTooLow: boolean;
}

export interface CrosschainQuote {
  srcChainId: number;
  dstChainId: number;
  inputToken: BridgeableToken;
  outputToken: BridgeableToken;
  inputAmount: string;     // human-readable
  inputAmountRaw: bigint;
  outputAmount: string;    // human-readable (after fees)
  outputAmountRaw: bigint;
  fee: AcrossFeeQuote;
  feePct: string;          // human-readable "0.61%"
  estimatedTime: string;   // "~2s"
}

// ── Aggregated NAV types ──────────────────────────────────────────────

/** Per-chain NAV snapshot + token balances */
export interface ChainNavSnapshot {
  chainId: number;
  chainName: string;
  /** NAV per pool token (18 decimals) — 0n if pool doesn't exist on this chain */
  unitaryValue: bigint;
  /** Total pool value in base token units */
  totalValue: bigint;
  /** Pool base token address on this chain */
  baseToken: Address;
  /** Pool base token symbol (ETH, WETH, POL, etc.) */
  baseTokenSymbol: string;
  /** Pool base token decimals */
  baseTokenDecimals: number;
  /** Bridgeable token balances held by the vault on this chain */
  tokenBalances: TokenBalance[];
  /** Whether delegation is active for the agent on this chain */
  delegationActive: boolean;
  /** Error message if we couldn't read this chain */
  error?: string;
}

export interface TokenBalance {
  token: BridgeableToken;
  balance: bigint;
  balanceFormatted: string;
  /** Approximate USD value (if USDC/USDT, 1:1; for WETH/WBTC, "unknown") */
  usdEstimate?: string;
}

/** Full aggregated NAV across all chains */
export interface AggregatedNav {
  vaultAddress: Address;
  chains: ChainNavSnapshot[];
  /** Chains where delegation is NOT active (user must set up) */
  missingDelegationChains: number[];
  /** Per-token aggregate across all chains */
  tokenTotals: Record<BridgeableTokenType, { total: string; chains: { chainId: number; amount: string }[] }>;
}

/** A single bridge operation recommended by the rebalancer */
/** Maximum NAV impact per bridge operation (matches NAV guard) */
const MAX_BRIDGE_NAV_IMPACT_PCT = 9n; // stay under the 10% guard

export interface BridgeRecommendation {
  srcChainId: number;
  srcChainName: string;
  dstChainId: number;
  dstChainName: string;
  tokenType: BridgeableTokenType;
  /** Human-readable amount to bridge in source token decimals */
  amount: string;
  amountRaw: bigint;
  /** Estimated fee */
  estimatedFeePct?: string;
  estimatedTime?: string;
  /** Estimated NAV impact on source chain (%) */
  navImpactPct?: string;
  /** true if the amount was capped to stay within the NAV guard limit */
  capped?: boolean;
}

/** Rebalancing plan */
export interface RebalancePlan {
  nav: AggregatedNav;
  targetChainId: number;
  targetChainName: string;
  operations: BridgeRecommendation[];
  /** Total estimated fees across all operations */
  totalEstimatedFees: string;
  /** Summary message */
  summary: string;
}

// ── RPC client helper ─────────────────────────────────────────────────

const clientCache = new Map<string, PublicClient>();

function getClient(chainId: number, alchemyKey?: string): PublicClient {
  const cacheKey = `crosschain:${chainId}:${alchemyKey ? "alchemy" : "public"}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId, alchemyKey);
  const client = createPublicClient({
    chain,
    transport: http(
      rpcUrl,
      rpcUrl?.includes("alchemy.com")
        ? { fetchOptions: { headers: { Origin: ALCHEMY_ORIGIN } } }
        : undefined,
    ),
  });
  clientCache.set(cacheKey, client);
  return client;
}

// ── Multi-chain NAV reader ────────────────────────────────────────────

/**
 * Read NAV data and bridgeable token balances for a vault across ALL
 * supported chains in parallel.
 *
 * Different chains may have different base tokens (ETH, WETH, POL, OP, etc.)
 * and different decimals — we read each independently and report raw values.
 */
export async function getAggregatedNav(
  vaultAddress: Address,
  alchemyKey: string,
  kv?: KVNamespace,
): Promise<AggregatedNav> {
  // Get delegation config to check which chains are set up
  let delegationConfig: DelegationConfig | null = null;
  if (kv) {
    delegationConfig = await getDelegationConfig(kv, vaultAddress);
  }
  const activeChains = delegationConfig ? new Set(getActiveChains(delegationConfig)) : new Set<number>();

  // Read NAV + balances on all chains in parallel
  const chainIds = Object.keys(CROSSCHAIN_TOKENS).map(Number);
  const snapshots = await Promise.all(
    chainIds.map((chainId) =>
      readChainSnapshot(vaultAddress, chainId, alchemyKey, activeChains.has(chainId)),
    ),
  );

  // Calculate per-token totals across chains
  // We normalise everything to the token's standard decimals (6 for USDC/USDT, 18 for WETH, 8 for WBTC)
  // BSC amounts are already in 18 decimals in the balance but we normalise for display
  const tokenTotals: AggregatedNav["tokenTotals"] = {} as AggregatedNav["tokenTotals"];
  const tokenTypes: BridgeableTokenType[] = ["USDC", "USDT", "WETH", "WBTC"];
  for (const tt of tokenTypes) {
    const chains: { chainId: number; amount: string }[] = [];
    for (const snap of snapshots) {
      if (snap.error) continue;
      const bal = snap.tokenBalances.find((b) => b.token.type === tt);
      if (bal && bal.balance > 0n) {
        chains.push({ chainId: snap.chainId, amount: bal.balanceFormatted });
      }
    }
    // Sum using normalised decimals: for display, we use the canonical decimals
    const canonicalDecimals = tt === "WETH" ? 18 : tt === "WBTC" ? 8 : 6;
    let totalRaw = 0n;
    for (const snap of snapshots) {
      if (snap.error) continue;
      const bal = snap.tokenBalances.find((b) => b.token.type === tt);
      if (bal && bal.balance > 0n) {
        // Normalise BSC 18-decimal USDC/USDT to 6 for aggregation
        if (snap.chainId === 56 && (tt === "USDC" || tt === "USDT")) {
          totalRaw += bal.balance / 1_000_000_000_000n;
        } else {
          totalRaw += bal.balance;
        }
      }
    }
    tokenTotals[tt] = {
      total: formatUnits(totalRaw, canonicalDecimals),
      chains,
    };
  }

  const missingDelegationChains = snapshots
    .filter((s) => !s.delegationActive && !s.error && s.totalValue > 0n)
    .map((s) => s.chainId);

  return {
    vaultAddress,
    chains: snapshots,
    missingDelegationChains,
    tokenTotals,
  };
}

/**
 * Read a single chain's NAV + token balances. Non-throwing — captures errors.
 */
async function readChainSnapshot(
  vaultAddress: Address,
  chainId: number,
  alchemyKey: string,
  delegationActive: boolean,
): Promise<ChainNavSnapshot> {
  const name = chainName(chainId);
  try {
    // Read pool data + NAV + all bridgeable token balances in parallel
    const bridgeableTokens = CROSSCHAIN_TOKENS[chainId] || [];

    const [poolData, navData, ...balances] = await Promise.all([
      getPoolData(chainId, vaultAddress, alchemyKey).catch(() => null),
      getNavData(chainId, vaultAddress, alchemyKey).catch(() => null),
      ...bridgeableTokens.map((token) =>
        getVaultTokenBalance(chainId, vaultAddress, token.address, alchemyKey)
          .catch(() => ({ balance: 0n, decimals: token.decimals, symbol: token.symbol })),
      ),
    ]);

    // If pool doesn't exist on this chain, return a minimal snapshot
    if (!poolData) {
      return {
        chainId,
        chainName: name,
        unitaryValue: 0n,
        totalValue: 0n,
        baseToken: "0x0000000000000000000000000000000000000000" as Address,
        baseTokenSymbol: "N/A",
        baseTokenDecimals: 18,
        tokenBalances: [],
        delegationActive,
      };
    }

    const tokenBalances: TokenBalance[] = bridgeableTokens.map((token, i) => {
      const bal = balances[i];
      return {
        token,
        balance: bal.balance,
        balanceFormatted: formatUnits(bal.balance, token.decimals),
      };
    }).filter((b) => b.balance > 0n);

    // Determine base token symbol — different on each chain
    let baseTokenSymbol = "ETH";
    if (poolData.baseToken.toLowerCase() === "0x0000000000000000000000000000000000000000") {
      const nativeSymbols: Record<number, string> = { 56: "BNB", 137: "POL" };
      baseTokenSymbol = nativeSymbols[chainId] || "ETH";
    } else {
      // Check if base token matches any bridgeable token
      const match = bridgeableTokens.find(
        (t) => t.address.toLowerCase() === poolData.baseToken.toLowerCase(),
      );
      baseTokenSymbol = match?.symbol || "ERC20";
    }

    return {
      chainId,
      chainName: name,
      unitaryValue: navData?.unitaryValue ?? 0n,
      totalValue: navData?.totalValue ?? 0n,
      baseToken: poolData.baseToken,
      baseTokenSymbol,
      baseTokenDecimals: poolData.decimals,
      tokenBalances,
      delegationActive,
    };
  } catch (err) {
    return {
      chainId,
      chainName: name,
      unitaryValue: 0n,
      totalValue: 0n,
      baseToken: "0x0000000000000000000000000000000000000000" as Address,
      baseTokenSymbol: "N/A",
      baseTokenDecimals: 18,
      tokenBalances: [],
      delegationActive,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Rebalancing optimizer ─────────────────────────────────────────────

/**
 * Build an optimised rebalancing plan.
 *
 * Strategy: for each bridgeable token type, move all balances from
 * non-target chains to the target chain in a single bridge per (source, token).
 * This minimises the number of transactions.
 *
 * If targetChainId is not specified, picks the chain with the largest
 * aggregate value (fewest bridge ops needed).
 */
export async function buildRebalancePlan(params: {
  vaultAddress: Address;
  targetChainId?: number;
  alchemyKey: string;
  kv?: KVNamespace;
}): Promise<RebalancePlan> {
  const nav = await getAggregatedNav(
    params.vaultAddress,
    params.alchemyKey,
    params.kv,
  );

  // Auto-select target chain if not specified: the one with the most value
  let targetChainId = params.targetChainId;
  if (!targetChainId) {
    let maxValue = 0n;
    for (const snap of nav.chains) {
      if (snap.totalValue > maxValue) {
        maxValue = snap.totalValue;
        targetChainId = snap.chainId;
      }
    }
    if (!targetChainId) {
      throw new Error("No vault data found on any chain.");
    }
  }

  const targetName = chainName(targetChainId);
  const targetTokens = CROSSCHAIN_TOKENS[targetChainId];
  if (!targetTokens) {
    throw new Error(`Target chain ${targetChainId} (${targetName}) does not support cross-chain tokens.`);
  }
  const targetTypes = new Set(targetTokens.map((t) => t.type));

  // Build bridge operations: one per (source chain, token type) where balance > 0
  const operations: BridgeRecommendation[] = [];

  for (const snap of nav.chains) {
    if (snap.chainId === targetChainId) continue;
    if (snap.error) continue;

    // Estimate total bridgeable value on this chain (in base-token-equivalent units)
    // For a rough impact %, we sum all bridgeable token values normalised to 18 decimals
    const totalChainValue = snap.totalValue; // already in base token units (18 dec)

    for (const bal of snap.tokenBalances) {
      // Only bridge if the target chain supports this token type
      if (!targetTypes.has(bal.token.type)) continue;
      if (bal.balance === 0n) continue;

      // Estimate this token's share of the chain's NAV.
      // Normalise token balance to 18 decimals for comparison with totalValue.
      const normalised = bal.balance * (10n ** (18n - BigInt(bal.token.decimals)));
      let bridgeAmount = bal.balance;
      let bridgeFormatted = bal.balanceFormatted;
      let capped = false;
      let impactPct = "N/A";

      if (totalChainValue > 0n) {
        const pct = (normalised * 100n) / totalChainValue;
        impactPct = `${pct.toString()}%`;

        // If bridging the full amount would exceed NAV guard, cap at safe amount
        if (pct > MAX_BRIDGE_NAV_IMPACT_PCT) {
          const safeNormalised = (totalChainValue * MAX_BRIDGE_NAV_IMPACT_PCT) / 100n;
          bridgeAmount = safeNormalised / (10n ** (18n - BigInt(bal.token.decimals)));
          const divisor = 10n ** BigInt(bal.token.decimals);
          const whole = bridgeAmount / divisor;
          const frac = (bridgeAmount % divisor).toString().padStart(bal.token.decimals, "0").slice(0, 6);
          bridgeFormatted = `${whole}.${frac}`;
          capped = true;
          impactPct = `~${MAX_BRIDGE_NAV_IMPACT_PCT}% (capped from ${pct}%)`;
        }
      }

      operations.push({
        srcChainId: snap.chainId,
        srcChainName: snap.chainName,
        dstChainId: targetChainId,
        dstChainName: targetName,
        tokenType: bal.token.type,
        amount: bridgeFormatted,
        amountRaw: bridgeAmount,
        navImpactPct: impactPct,
        capped,
      });
    }
  }

  // Fetch fee estimates for all operations in parallel
  const feePromises = operations.map(async (op) => {
    try {
      const quote = await getCrosschainQuote(
        op.srcChainId,
        op.dstChainId,
        op.tokenType,
        op.amount,
      );
      op.estimatedFeePct = quote.feePct;
      op.estimatedTime = quote.estimatedTime;
    } catch {
      op.estimatedFeePct = "N/A";
      op.estimatedTime = "N/A";
    }
  });
  await Promise.all(feePromises);

  // Build summary
  const totalOps = operations.length;
  const summary = totalOps === 0
    ? `All bridgeable tokens are already on ${targetName}. No rebalancing needed.`
    : `Rebalance to ${targetName}: ${totalOps} bridge operation${totalOps > 1 ? "s" : ""} needed.`;

  return {
    nav,
    targetChainId,
    targetChainName: targetName,
    operations,
    totalEstimatedFees: operations.map((o) => o.estimatedFeePct || "0%").join(", "),
    summary,
  };
}

// ── Across fee quoting ────────────────────────────────────────────────

/**
 * Fetch suggested fees from the Across API.
 *
 * Uses the `app.across.to/api/suggested-fees` endpoint with:
 *   inputToken, outputToken, originChainId, destinationChainId, amount
 */
export async function getAcrossSuggestedFees(
  srcChainId: number,
  dstChainId: number,
  inputToken: Address,
  outputToken: Address,
  amount: bigint,
): Promise<AcrossFeeQuote> {
  const url = new URL(ACROSS_API);
  url.searchParams.set("inputToken", inputToken);
  url.searchParams.set("outputToken", outputToken);
  url.searchParams.set("originChainId", srcChainId.toString());
  url.searchParams.set("destinationChainId", dstChainId.toString());
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("skipAmountLimit", "true");

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Across API error (${resp.status}): ${body.slice(0, 200)}`,
    );
  }

  const data = (await resp.json()) as {
    totalRelayFee: { pct: string; total: string };
    timestamp: string;
    estimatedFillTimeSec: number;
    exclusiveRelayer: string;
    exclusivityDeadline: number;
    spokePoolAddress: string;
    isAmountTooLow: boolean;
  };

  return {
    totalRelayFeeRaw: BigInt(data.totalRelayFee.total),
    totalRelayFeePct: data.totalRelayFee.pct,
    estimatedFillTimeSec: data.estimatedFillTimeSec,
    quoteTimestamp: Number(data.timestamp),
    exclusiveRelayer: data.exclusiveRelayer as Address,
    exclusivityDeadline: data.exclusivityDeadline,
    spokePoolAddress: data.spokePoolAddress as Address,
    isAmountTooLow: data.isAmountTooLow,
  };
}

// ── Quote builder ─────────────────────────────────────────────────────

/**
 * Build a complete cross-chain quote (fee estimation, input/output amounts).
 *
 * Handles decimal normalisation between chains (e.g. BSC USDC is 18 decimals,
 * all others are 6). The Across API expects normalised amounts.
 */
export async function getCrosschainQuote(
  srcChainId: number,
  dstChainId: number,
  tokenSymbol: string,
  amount: string,
): Promise<CrosschainQuote> {
  // Resolve tokens on both chains
  const inputToken = findBridgeableToken(srcChainId, tokenSymbol);
  if (!inputToken) {
    const available = CROSSCHAIN_TOKENS[srcChainId]
      ?.map((t) => t.symbol)
      .join(", ") ?? "none";
    throw new Error(
      `${tokenSymbol} is not bridgeable on chain ${srcChainId}. Available: ${available}`,
    );
  }

  const outputToken = getOutputToken(srcChainId, dstChainId, inputToken.address);
  if (!outputToken) {
    throw new Error(
      `No matching ${inputToken.type} token on destination chain ${dstChainId}.`,
    );
  }

  // Parse amount using source token decimals
  const inputAmountRaw = parseUnits(amount, inputToken.decimals);

  // For Across API: normalise amount (BSC tokens need decimal conversion)
  // Across expects amounts in the canonical decimals (6 for USDC, 18 for WETH, etc.)
  const acrossAmount = applyBscDecimalConversion(
    inputToken.address,
    outputToken.address,
    inputAmountRaw,
  );

  // Fetch suggested fees
  const fee = await getAcrossSuggestedFees(
    srcChainId,
    dstChainId,
    inputToken.address,
    outputToken.address,
    acrossAmount,
  );

  if (fee.isAmountTooLow) {
    throw new Error(
      `Amount ${amount} ${tokenSymbol} is too low for cross-chain transfer. ` +
      `Across requires a higher minimum.`,
    );
  }

  // Validate fee doesn't exceed 2% (matches AIntents MAX_BRIDGE_FEE_BPS)
  const feeBps = Number(
    (fee.totalRelayFeeRaw * 10_000n) / acrossAmount,
  );
  if (feeBps > MAX_BRIDGE_FEE_BPS) {
    throw new Error(
      `Bridge fee (${(feeBps / 100).toFixed(2)}%) exceeds maximum ${MAX_BRIDGE_FEE_BPS / 100}%. ` +
      `Try a larger amount or wait for lower fees.`,
    );
  }

  // OutputAmount = inputAmount - fee (in Across-normalised units)
  const outputAmountRaw = acrossAmount - fee.totalRelayFeeRaw;

  // Convert back to destination decimals if BSC is involved
  const displayOutputRaw = applyBscDecimalConversion(
    outputToken.address,
    inputToken.address,
    outputAmountRaw,
  );

  const feePctNum = (Number(fee.totalRelayFeePct) / 1e18) * 100;

  return {
    srcChainId,
    dstChainId,
    inputToken,
    outputToken,
    inputAmount: amount,
    inputAmountRaw,
    outputAmount: formatUnits(displayOutputRaw, outputToken.decimals),
    outputAmountRaw: outputAmountRaw,
    fee,
    feePct: `${feePctNum.toFixed(4)}%`,
    estimatedTime: fee.estimatedFillTimeSec < 60
      ? `~${fee.estimatedFillTimeSec}s`
      : `~${Math.round(fee.estimatedFillTimeSec / 60)}min`,
  };
}

// ── SourceMessageParams encoding ──────────────────────────────────────

/**
 * ABI-encode SourceMessageParams for the `message` field of AcrossParams.
 *
 * struct SourceMessageParams {
 *   OpType opType;
 *   uint256 navTolerance;
 *   uint256 sourceNativeAmount;
 *   bool shouldUnwrapOnDestination;
 * }
 *
 * When sourceNativeAmount > 0, the vault wraps that amount of native ETH into
 * WETH before bridging. This means the caller does NOT need a WETH balance —
 * only sufficient native ETH.
 */
function encodeSourceMessage(
  opType: OpType,
  navToleranceBps: number = DEFAULT_NAV_TOLERANCE_BPS,
  sourceNativeAmount: bigint = 0n,
  shouldUnwrapOnDestination: boolean = false,
): Hex {
  return encodeAbiParameters(
    parseAbiParameters("uint8, uint256, uint256, bool"),
    [
      opType,                          // opType
      BigInt(navToleranceBps),         // navTolerance (in bps)
      sourceNativeAmount,              // sourceNativeAmount (wei; vault wraps ETH→WETH)
      shouldUnwrapOnDestination,       // shouldUnwrapOnDestination
    ],
  );
}

// ── depositV3 calldata builder ────────────────────────────────────────

/**
 * Build the full depositV3 calldata to be called on the vault.
 *
 * The vault routes `depositV3(AcrossParams)` through its AIntents adapter,
 * which validates token pairs, creates an escrow, and calls SpokePool.depositV3.
 */
export function buildDepositV3Calldata(params: {
  vaultAddress: Address;
  inputToken: Address;
  outputToken: Address;
  inputAmount: bigint;
  outputAmount: bigint;
  destinationChainId: number;
  quoteTimestamp: number;
  exclusiveRelayer: Address;
  exclusivityDeadline: number;
  opType: OpType;
  navToleranceBps?: number;
  sourceNativeAmount?: bigint;
  shouldUnwrapOnDestination?: boolean;
}): Hex {
  const fillDeadline = params.quoteTimestamp + DEFAULT_FILL_DEADLINE_SECS;
  const message = encodeSourceMessage(
    params.opType,
    params.navToleranceBps ?? DEFAULT_NAV_TOLERANCE_BPS,
    params.sourceNativeAmount ?? 0n,
    params.shouldUnwrapOnDestination ?? false,
  );

  // The 'depositor' field: set to vault address; AIntents will override
  // it internally with the escrow address for refund handling.
  // The 'recipient' is the vault on the destination chain (same address).
  const acrossParams = {
    depositor: params.vaultAddress,
    recipient: params.vaultAddress,
    inputToken: params.inputToken,
    outputToken: params.outputToken,
    inputAmount: params.inputAmount,
    outputAmount: params.outputAmount,
    destinationChainId: BigInt(params.destinationChainId),
    exclusiveRelayer: params.exclusiveRelayer,
    quoteTimestamp: params.quoteTimestamp,
    fillDeadline,
    exclusivityDeadline: params.exclusivityDeadline,
    message,
  };

  return encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "depositV3",
    args: [acrossParams],
  });
}

// ── High-level builders ───────────────────────────────────────────────

/**
 * Build a cross-chain transfer transaction (OpType.Transfer).
 *
 * Returns an unsigned transaction targeting the vault, ready for
 * the existing execution pipeline (manual or delegated mode).
 */
export async function buildCrosschainTransfer(params: {
  vaultAddress: Address;
  srcChainId: number;
  dstChainId: number;
  tokenSymbol: string;
  amount: string;       // human-readable
  useNativeEth?: boolean;  // true = vault wraps native ETH→WETH via sourceNativeAmount
  shouldUnwrapOnDestination?: boolean;
  alchemyKey?: string;
}): Promise<{
  quote: CrosschainQuote;
  calldata: Hex;
  description: string;
}> {
  // Prevent same-chain transfers (AIntents enforces this too)
  if (params.srcChainId === params.dstChainId) {
    throw new Error("Cross-chain transfer requires different source and destination chains.");
  }

  const inputToken = findBridgeableToken(params.srcChainId, params.tokenSymbol);
  if (!inputToken) {
    throw new Error(`${params.tokenSymbol} is not bridgeable on chain ${params.srcChainId}.`);
  }

  const inputAmountRaw = parseUnits(params.amount, inputToken.decimals);

  // When useNativeEth is set (only valid for WETH), check native ETH balance
  // instead of WETH balance — the vault will wrap ETH→WETH automatically
  // via the sourceNativeAmount field in SourceMessageParams.
  const useNative = params.useNativeEth && inputToken.type === "WETH";

  if (useNative) {
    const { balance: ethBalance } = await getVaultTokenBalance(
      params.srcChainId,
      params.vaultAddress,
      "0x0000000000000000000000000000000000000000" as Address,
      params.alchemyKey,
    );
    if (ethBalance < inputAmountRaw) {
      const available = formatUnits(ethBalance, 18);
      throw new Error(
        `Insufficient native ETH balance in vault on ${chainName(params.srcChainId)}. ` +
        `Available: ${available}, requested: ${params.amount}.`,
      );
    }
  } else {
    const { balance } = await getVaultTokenBalance(
      params.srcChainId,
      params.vaultAddress,
      inputToken.address,
      params.alchemyKey,
    );
    if (balance < inputAmountRaw) {
      const available = formatUnits(balance, inputToken.decimals);
      throw new Error(
        `Insufficient ${inputToken.symbol} balance in vault on ${chainName(params.srcChainId)}. ` +
        `Available: ${available}, requested: ${params.amount}.`,
      );
    }
  }

  // Get quote
  const quote = await getCrosschainQuote(
    params.srcChainId,
    params.dstChainId,
    params.tokenSymbol,
    params.amount,
  );

  // Build calldata — include sourceNativeAmount when using native ETH
  const calldata = buildDepositV3Calldata({
    vaultAddress: params.vaultAddress,
    inputToken: quote.inputToken.address,
    outputToken: quote.outputToken.address,
    inputAmount: quote.inputAmountRaw,
    outputAmount: quote.outputAmountRaw,
    destinationChainId: params.dstChainId,
    quoteTimestamp: quote.fee.quoteTimestamp,
    exclusiveRelayer: quote.fee.exclusiveRelayer,
    exclusivityDeadline: quote.fee.exclusivityDeadline,
    opType: OpType.Transfer,
    sourceNativeAmount: useNative ? inputAmountRaw : undefined,
    shouldUnwrapOnDestination: params.shouldUnwrapOnDestination,
  });

  const srcName = chainName(params.srcChainId);
  const dstName = chainName(params.dstChainId);
  const description =
    `Bridge ${params.amount} ${quote.inputToken.symbol} from ${srcName} → ${dstName}` +
    ` (receive ~${quote.outputAmount} ${quote.outputToken.symbol}, fee ${quote.feePct}, ${quote.estimatedTime})`;

  return { quote, calldata, description };
}

/**
 * Build a cross-chain sync transaction (OpType.Sync).
 *
 * If amount is not provided, auto-calculates the minimum needed to cover
 * Across bridge fees. Picks a bridgeable token available on both chains.
 *
 * Syncs NAV data from source chain to destination chain using the
 * AIntents Sync opType — validates NAV impact tolerance without moving
 * significant value.
 */
export async function buildCrosschainSync(params: {
  vaultAddress: Address;
  srcChainId: number;
  dstChainId: number;
  tokenSymbol?: string;   // auto-selects if omitted
  amount?: string;        // auto-calculates if omitted
  navToleranceBps?: number;
  alchemyKey?: string;
}): Promise<{
  quote: CrosschainQuote;
  calldata: Hex;
  description: string;
}> {
  if (params.srcChainId === params.dstChainId) {
    throw new Error("Cross-chain sync requires different source and destination chains.");
  }

  // Auto-select token: pick the first bridgeable token with sufficient balance
  let tokenSymbol = params.tokenSymbol;
  let amount = params.amount;

  if (!tokenSymbol) {
    const srcTokens = CROSSCHAIN_TOKENS[params.srcChainId] || [];
    const dstTokens = new Set(
      (CROSSCHAIN_TOKENS[params.dstChainId] || []).map((t) => t.type),
    );

    // Find first token available on both chains with balance > minimum
    for (const token of srcTokens) {
      if (!dstTokens.has(token.type)) continue;
      const { balance } = await getVaultTokenBalance(
        params.srcChainId,
        params.vaultAddress,
        token.address,
        params.alchemyKey,
      );
      const minAmount = MIN_SYNC_AMOUNTS[token.type];
      const minRaw = parseUnits(minAmount, token.decimals);
      if (balance >= minRaw) {
        tokenSymbol = token.type;
        break;
      }
    }
    if (!tokenSymbol) {
      throw new Error(
        `No bridgeable token with sufficient balance found on ${chainName(params.srcChainId)} ` +
        `for syncing to ${chainName(params.dstChainId)}.`,
      );
    }
  }

  // Auto-calculate amount if not provided
  if (!amount) {
    const t = findBridgeableToken(params.srcChainId, tokenSymbol);
    amount = t ? MIN_SYNC_AMOUNTS[t.type] : "2";
  }

  // Verify balance
  const inputToken = findBridgeableToken(params.srcChainId, tokenSymbol);
  if (!inputToken) {
    throw new Error(`${tokenSymbol} is not bridgeable on chain ${params.srcChainId}.`);
  }

  const { balance } = await getVaultTokenBalance(
    params.srcChainId,
    params.vaultAddress,
    inputToken.address,
    params.alchemyKey,
  );
  const inputAmountRaw = parseUnits(amount, inputToken.decimals);
  if (balance < inputAmountRaw) {
    const available = formatUnits(balance, inputToken.decimals);
    throw new Error(
      `Insufficient ${inputToken.symbol} balance on ${chainName(params.srcChainId)} for sync. ` +
      `Available: ${available}, needed: ${amount}.`,
    );
  }

  // Get quote
  const quote = await getCrosschainQuote(
    params.srcChainId,
    params.dstChainId,
    tokenSymbol,
    amount,
  );

  const toleranceBps = params.navToleranceBps ?? DEFAULT_NAV_TOLERANCE_BPS;

  // Build calldata
  const calldata = buildDepositV3Calldata({
    vaultAddress: params.vaultAddress,
    inputToken: quote.inputToken.address,
    outputToken: quote.outputToken.address,
    inputAmount: quote.inputAmountRaw,
    outputAmount: quote.outputAmountRaw,
    destinationChainId: params.dstChainId,
    quoteTimestamp: quote.fee.quoteTimestamp,
    exclusiveRelayer: quote.fee.exclusiveRelayer,
    exclusivityDeadline: quote.fee.exclusivityDeadline,
    opType: OpType.Sync,
    navToleranceBps: toleranceBps,
  });

  const srcName = chainName(params.srcChainId);
  const dstName = chainName(params.dstChainId);
  const description =
    `Sync NAV from ${srcName} → ${dstName} using ${amount} ${quote.inputToken.symbol}` +
    ` (tolerance: ${(toleranceBps / 100).toFixed(2)}%, fee: ${quote.feePct})`;

  return { quote, calldata, description };
}

// ── Helpers ───────────────────────────────────────────────────────────

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  130: "Unichain",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
};

export function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}
