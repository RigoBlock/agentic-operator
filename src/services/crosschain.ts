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
 * ## NAV Shield
 * The existing NAV shield in execution.ts (`checkNavImpact`) runs on ALL
 * delegated transactions regardless of function selector. It simulates
 * `multicall([txData, getNavDataView])` via eth_call and rejects if
 * the unitary value drops >10%. This automatically covers `depositV3`
 * and any future vault methods — no per-method extension needed.
 *
 * ## Decimals
 * Token decimals vary across chains (BSC USDC/USDT are 18 vs 6 elsewhere).
 * Amounts are sent to the Across API in the input token's native decimals.
 * The Across API returns outputAmount in the OUTPUT token's native decimals
 * (what the solver delivers on the destination chain). We pass this directly
 * to the contract — the on-chain AIntents adapter normalises via
 * CrosschainLib.applyBscDecimalConversion for its sanity checks.
 *
 * @see https://github.com/RigoBlock/v3-contracts/blob/master/contracts/protocol/extensions/adapters/AIntents.sol
 */

import {
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  decodeAbiParameters,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { ACROSS_SPOKE_POOL_ABI } from "../abi/aIntents.js";
import { getRpcUrl } from "../config.js";
import {
  OpType,
  ACROSS_SPOKE_POOL,
  CROSSCHAIN_TOKENS,
  findBridgeableToken,
  getOutputToken,
  getAcrossHandler,
  type BridgeableToken,
  type BridgeableTokenType,
} from "./crosschainConfig.js";
import { getVaultTokenBalance, getNavData, getPoolData, getClient, getEffectivePoolState } from "./vault.js";
import type { EffectivePoolState } from "./vault.js";
import { getDelegationConfig, getActiveChains } from "./delegation.js";
import type { DelegationConfig } from "../types.js";

// ── Constants

/** Maximum bridge fee as bps (2% — hard-coded in AIntents.sol as MAX_BRIDGE_FEE_BPS) */
const MAX_BRIDGE_FEE_BPS = 200;

/** Default fill deadline window: 6 hours from quote timestamp */
const DEFAULT_FILL_DEADLINE_SECS = 6 * 60 * 60; // 21 600

/** Default NAV tolerance for Sync ops (100 bps = 1%) */
const DEFAULT_NAV_TOLERANCE_BPS = 100;

/** NAV tolerance for Transfer ops (8700 bps = 87%).
 *  On-chain MINIMUM_SUPPLY_RATIO = 8 → effective supply must stay ≥ totalSupply/8
 *  → max bridgeable = 87.5% of total. We use 8700 bps (87%) with margin. */
const TRANSFER_NAV_TOLERANCE_BPS = 8700;

/** Max bridgeable fraction of vault balance (7/8 = 87.5%).
 *  On-chain NavImpactLib.MINIMUM_SUPPLY_RATIO = 8 means effective supply
 *  must be ≥ totalSupply / 8 after bridging. */
const MAX_BRIDGE_FRACTION_NUM = 7n;
const MAX_BRIDGE_FRACTION_DEN = 8n;

/** Across suggested-fees API base URL */
const ACROSS_API = "https://app.across.to/api/suggested-fees";

/**
 * Fallback sync amounts per token type (human-readable).
 * Used only when no amount is specified and equalization is not active.
 * The Across `isAmountTooLow` flag and on-chain OutputAmountTooLow revert
 * are the real guards — these are just sensible defaults for manual sync.
 */
const FALLBACK_SYNC_AMOUNTS: Record<BridgeableTokenType, string> = {
  USDC: "2",
  USDT: "2",
  WETH: "0.001",
  WBTC: "0.0001",
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
  /** Output amount in output token's native decimals (from Across API) */
  outputAmountRaw: bigint;
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
  /** NAV per pool token (in base token decimals) — 0n if pool doesn't exist on this chain */
  unitaryValue: bigint;
  /** Total pool value in base token units */
  totalValue: bigint;
  /** Total pool token supply (18 decimals) */
  totalSupply: bigint;
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
/** Maximum bridge fraction of a chain's value (7/8 = 87.5%).
 *  Matches on-chain NavImpactLib.MINIMUM_SUPPLY_RATIO = 8. */
const MAX_BRIDGE_NAV_IMPACT_PCT = 87n;

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
  /** true if the amount was capped to stay within the NAV shield limit */
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
    .filter((s) => !s.delegationActive && !s.error && (s.totalValue > 0n || s.totalSupply > 0n))
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
    // Read pool data + NAV + total supply + all bridgeable token balances in parallel
    const bridgeableTokens = CROSSCHAIN_TOKENS[chainId] || [];

    const [poolData, navData, totalSupplyRaw, ...balances] = await Promise.all([
      getPoolData(chainId, vaultAddress, alchemyKey).catch(() => null),
      getNavData(chainId, vaultAddress, alchemyKey).catch(() => null),
      getClient(chainId, alchemyKey).readContract({
        address: vaultAddress,
        abi: [{ name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const,
        functionName: "totalSupply",
      }).catch(() => 0n),
      ...bridgeableTokens.map((token) =>
        getVaultTokenBalance(chainId, vaultAddress, token.address, alchemyKey)
          .catch(() => ({ balance: 0n, decimals: token.decimals, symbol: token.symbol })),
      ),
    ]);

    // Build token balances regardless of whether pool data loaded
    const tokenBalances: TokenBalance[] = bridgeableTokens.map((token, i) => {
      const bal = balances[i];
      return {
        token,
        balance: bal.balance,
        balanceFormatted: formatUnits(bal.balance, token.decimals),
      };
    }).filter((b) => b.balance > 0n);

    // If pool data unavailable (shouldn't happen with V4's getPool()), use
    // individual calls for decimals and match base token from bridgeable tokens.
    if (!poolData) {
      let fallbackDecimals = 18;
      try {
        const dec = await getClient(chainId, alchemyKey).readContract({
          address: vaultAddress,
          abi: [{ name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const,
          functionName: "decimals",
        });
        fallbackDecimals = Number(dec);
      } catch { /* keep default 18 */ }

      // Match by decimals against bridgeable tokens — prefer stablecoins
      let fallbackSymbol = "UNKNOWN";
      const matchingTokens = bridgeableTokens.filter((t) => t.decimals === fallbackDecimals);
      if (matchingTokens.length > 0) {
        fallbackSymbol = matchingTokens[0].symbol;
      }

      return {
        chainId,
        chainName: name,
        unitaryValue: navData?.unitaryValue ?? 0n,
        totalValue: navData?.totalValue ?? 0n,
        totalSupply: totalSupplyRaw as bigint,
        baseToken: "0x0000000000000000000000000000000000000000" as Address,
        baseTokenSymbol: (navData || tokenBalances.length > 0) ? fallbackSymbol : "N/A",
        baseTokenDecimals: fallbackDecimals,
        tokenBalances,
        delegationActive,
      };
    }

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
      totalSupply: totalSupplyRaw as bigint,
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
      totalSupply: 0n,
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

        // If bridging the full amount would exceed NAV shield, cap at safe amount
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
 * Fixed USD-equivalent deduction from outputAmount per destination chain.
 *
 * The Across solver must execute handleV3AcrossMessage on the destination vault,
 * which runs NAV calculation + donate — significantly more gas than a plain
 * token transfer (~300-500k gas). Across doesn't know about this overhead
 * (it can't simulate the AIntents adapter), so we deduct it manually from
 * the minimum output the solver must deliver. Without this, solvers won't
 * fill profitably.
 *
 * These values are always applied (not a cap). For non-stablecoin tokens
 * (WETH/WBTC), the USD overhead is converted to token units using a live
 * market price fetched at quote time via fetchTokenPriceUsd().
 *
 * Values are based on observed destination gas usage (~350K for sync fills,
 * ~500K for transfers) with 3-5x safety margin. A percentage cap
 * (MAX_OVERHEAD_BPS) prevents disproportionate deduction on small amounts.
 *
 * NOTE: When operatorAddress is provided, buildCrosschainTransfer/buildCrosschainSync
 * simulate depositV3 via debug_traceCall to extract the expanded destination message,
 * then re-query Across with recipient+message for accurate gas-inclusive fees.
 * The static overheads below are only used as a fallback when simulation is unavailable.
 */
const AINTENTS_GAS_OVERHEAD_USD: Record<number, number> = {
  1:     0.50,   // Ethereum — 500K gas, variable gwei, conservative
  56:    0.05,   // BSC — 350K gas at 0.05 gwei, BNB ~$600 → ~$0.01 gas
  137:   0.03,   // Polygon — 500K gas at 30 gwei, POL ~$0.50
  10:    0.10,   // Optimism — L2 fees + L1 data posting
  8453:  0.10,   // Base — L2 fees + L1 data posting
  42161: 0.15,   // Arbitrum — 500K gas at 0.1 gwei, ETH ~$3000
  130:   0.03,   // Unichain — L2 fees
};

/**
 * Maximum overhead deduction as a fraction of bridge amount (basis points).
 * Prevents the fixed USD overhead from consuming too much of small transfers.
 * 50 bps = 0.5% — leaves room for the Across relay fee within the on-chain
 * MAX_BRIDGE_FEE_BPS (200 bps = 2%) limit.
 */
const MAX_OVERHEAD_BPS = 50n;

/** CoinGecko API IDs for live price lookups */
const COINGECKO_IDS: Record<string, string> = {
  WETH: "ethereum",
  WBTC: "bitcoin",
};

/**
 * Fetch live USD price for a bridgeable token type.
 * Stablecoins return 1 without a network call.
 * For WETH/WBTC, queries the CoinGecko Simple Price API (free, no key).
 * Falls back to a conservative floor if the API is unavailable.
 */
async function fetchTokenPriceUsd(tokenType: BridgeableTokenType): Promise<number> {
  if (tokenType === "USDC" || tokenType === "USDT") return 1;

  const id = COINGECKO_IDS[tokenType];
  if (!id) return 1;

  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
    );
    if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
    const data = (await resp.json()) as Record<string, { usd?: number }>;
    const price = data[id]?.usd;
    if (price && price > 0) return price;
    throw new Error("No price in response");
  } catch {
    // Conservative floor: intentionally LOW so we deduct MORE tokens as
    // overhead, giving the solver better margin. Safe for fills but the
    // user pays slightly more than necessary.
    return tokenType === "WBTC" ? 30000 : 1000;
  }
}

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
  /** Optional: destination fill recipient (from simulation) */
  recipient?: Address,
  /** Optional: destination fill message (from simulation) */
  message?: Hex,
): Promise<AcrossFeeQuote> {
  const url = new URL(ACROSS_API);
  url.searchParams.set("inputToken", inputToken);
  url.searchParams.set("outputToken", outputToken);
  url.searchParams.set("originChainId", srcChainId.toString());
  url.searchParams.set("destinationChainId", dstChainId.toString());
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("skipAmountLimit", "true");
  url.searchParams.set("allowUnmatchedDecimals", "true");
  // When recipient + message are available (from depositV3 simulation),
  // the Across API can simulate the destination fill and return accurate
  // gas-inclusive fees, eliminating the need for static overhead deduction.
  if (recipient) url.searchParams.set("recipient", recipient);
  if (message) url.searchParams.set("message", message);

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
    outputAmount: string;
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
    outputAmountRaw: BigInt(data.outputAmount),
  };
}

// ── Quote builder ─────────────────────────────────────────────────────

/**
 * Build a complete cross-chain quote (fee estimation, input/output amounts).
 *
 * The Across API expects amounts in the input token's native decimals and
 * returns outputAmount in the OUTPUT token's native decimals (what the solver
 * delivers on destination). We pass this to the contract as-is.
 *
 * A fixed USD-equivalent is deducted from the Across outputAmount to cover
 * the AIntents handleV3AcrossMessage overhead on the destination chain
 * (NAV calculation + donate call). See AINTENTS_GAS_OVERHEAD_USD.
 */
export async function getCrosschainQuote(
  srcChainId: number,
  dstChainId: number,
  tokenSymbol: string,
  amount: string,
  /** When provided (from depositV3 simulation), the Across API estimates
   *  destination fill gas accurately and no static overhead deduction is needed. */
  simulatedFill?: { recipient: Address; message: Hex },
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

  // Parse amount in input token's native decimals (e.g. 18 for BSC USDT)
  const inputAmountRaw = parseUnits(amount, inputToken.decimals);

  // Fetch suggested fees and live token price in parallel (zero added latency)
  const [fee, tokenPrice] = await Promise.all([
    getAcrossSuggestedFees(
      srcChainId,
      dstChainId,
      inputToken.address,
      outputToken.address,
      inputAmountRaw,
      simulatedFill?.recipient,
      simulatedFill?.message,
    ),
    // Only need token price for static overhead (skip when simulation available)
    simulatedFill ? Promise.resolve(1) : fetchTokenPriceUsd(outputToken.type),
  ]);

  if (fee.isAmountTooLow) {
    throw new Error(
      `Amount ${amount} ${tokenSymbol} is too low for cross-chain transfer. ` +
      `Across requires a higher minimum.`,
    );
  }

  // Fee is in input token decimals — validate against MAX_BRIDGE_FEE_BPS
  const feeBps = Number(
    (fee.totalRelayFeeRaw * 10_000n) / inputAmountRaw,
  );
  if (feeBps > MAX_BRIDGE_FEE_BPS) {
    throw new Error(
      `Bridge fee (${(feeBps / 100).toFixed(2)}%) exceeds maximum ${MAX_BRIDGE_FEE_BPS / 100}%. ` +
      `Try a larger amount or wait for lower fees.`,
    );
  }

  // Across API returns outputAmount in OUTPUT token's native decimals
  // (what the solver must deliver on destination). Pass as-is to the contract.
  let outputAmountRaw = fee.outputAmountRaw;

  // When simulation data was provided, the Across API already accounts for
  // destination fill gas in its outputAmount — no static overhead needed.
  // Otherwise, fall back to the static USD deduction.
  if (!simulatedFill) {
    // Deduct the AIntents gas overhead (handleV3AcrossMessage: NAV calc + donate)
    // that the solver must pay on the destination chain. Across doesn't model
    // the AIntents adapter (we can't pass the destination message since the vault
    // expands SourceMessageParams internally), so we compensate with a static
    // USD deduction capped at MAX_OVERHEAD_BPS of the bridge amount.
    const overheadUsd = AINTENTS_GAS_OVERHEAD_USD[dstChainId] ?? 0.05;
    const overheadInToken = overheadUsd / tokenPrice;
    let overheadRaw = parseUnits(
      overheadInToken.toFixed(outputToken.decimals),
      outputToken.decimals,
    );

    // Cap: overhead must not exceed MAX_OVERHEAD_BPS of the bridge amount.
    // Convert inputAmount to output-token decimals for an apples-to-apples cap.
    const inputInOutputDec = inputToken.decimals >= outputToken.decimals
      ? inputAmountRaw / (10n ** BigInt(inputToken.decimals - outputToken.decimals))
      : inputAmountRaw * (10n ** BigInt(outputToken.decimals - inputToken.decimals));
    const maxOverheadRaw = inputInOutputDec * MAX_OVERHEAD_BPS / 10_000n;
    if (overheadRaw > maxOverheadRaw) {
      overheadRaw = maxOverheadRaw;
    }

    if (outputAmountRaw > overheadRaw) {
      outputAmountRaw = outputAmountRaw - overheadRaw;
    }
  }

  const feePctNum = (Number(fee.totalRelayFeePct) / 1e18) * 100;

  return {
    srcChainId,
    dstChainId,
    inputToken,
    outputToken,
    inputAmount: amount,
    inputAmountRaw,
    outputAmount: formatUnits(outputAmountRaw, outputToken.decimals),
    outputAmountRaw,
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

// ── depositV3 simulation for destination message extraction ───────────

/** FundsDeposited event topic hash (V3 SpokePool) */
const FUNDS_DEPOSITED_TOPIC = "0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3";

/** Alchemy Origin header required for API calls */
const ALCHEMY_ORIGIN = "https://trader.rigoblock.com";

/** Log entry from callTracer withLog */
interface TraceLog {
  address: string;
  topics: string[];
  data: string;
}

/** Nested call frame from callTracer */
interface CallFrame {
  type: string;
  from: string;
  to: string;
  input: string;
  output?: string;
  error?: string;
  calls?: CallFrame[];
  logs?: TraceLog[];
}

/**
 * Simulate a depositV3 call via debug_traceCall to extract the expanded
 * destination message and recipient from the FundsDeposited event.
 *
 * The AIntents adapter internally expands SourceMessageParams into a full
 * 4-call multicall (storeBalance → transfer → drainLeftovers → donate).
 * The expanded message is emitted in the FundsDeposited event on the
 * Across SpokePool. We extract it here so the Across API can estimate
 * the destination fill gas accurately.
 *
 * Uses debug_traceCall with callTracer + withLog:true to capture event logs
 * from the simulation without actually broadcasting the transaction.
 * The simulation runs as the vault owner (operator) since depositV3 requires
 * vault authorization.
 *
 * @returns The recipient and message from FundsDeposited, or null if simulation fails.
 */
export async function simulateDepositV3ForMessage(params: {
  vaultAddress: Address;
  calldata: Hex;
  srcChainId: number;
  operatorAddress: Address;
  alchemyKey?: string;
}): Promise<{ recipient: Hex; message: Hex } | null> {
  const rpcUrl = getRpcUrl(params.srcChainId, params.alchemyKey);
  if (!rpcUrl) {
    console.warn("[Crosschain] No Alchemy RPC for simulation, skipping depositV3 trace");
    return null;
  }

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": ALCHEMY_ORIGIN,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "debug_traceCall",
        params: [
          {
            from: params.operatorAddress,
            to: params.vaultAddress,
            data: params.calldata,
          },
          "latest",
          {
            tracer: "callTracer",
            tracerConfig: { withLog: true },
          },
        ],
      }),
    });

    if (!response.ok) {
      console.warn(`[Crosschain] debug_traceCall HTTP ${response.status}`);
      return null;
    }

    const json = await response.json() as { result?: CallFrame; error?: { message: string } };
    if (json.error || !json.result) {
      console.warn(`[Crosschain] debug_traceCall error: ${json.error?.message || "no result"}`);
      return null;
    }

    // Recursively search all call frames for the FundsDeposited log
    const log = findLogByTopic(json.result, FUNDS_DEPOSITED_TOPIC);
    if (!log) {
      console.warn("[Crosschain] FundsDeposited event not found in trace");
      return null;
    }

    // Decode the non-indexed params from event data.
    // FundsDeposited data layout (V3 SpokePool with bytes32 addresses):
    //   bytes32 inputToken, bytes32 outputToken, uint256 inputAmount,
    //   uint256 outputAmount, uint32 quoteTimestamp, uint32 fillDeadline,
    //   uint32 exclusivityDeadline, bytes32 recipient, bytes32 exclusiveRelayer,
    //   bytes message
    const decoded = decodeAbiParameters(
      [
        { name: "inputToken", type: "bytes32" },
        { name: "outputToken", type: "bytes32" },
        { name: "inputAmount", type: "uint256" },
        { name: "outputAmount", type: "uint256" },
        { name: "quoteTimestamp", type: "uint32" },
        { name: "fillDeadline", type: "uint32" },
        { name: "exclusivityDeadline", type: "uint32" },
        { name: "recipient", type: "bytes32" },
        { name: "exclusiveRelayer", type: "bytes32" },
        { name: "message", type: "bytes" },
      ],
      log.data as Hex,
    );

    // recipient is bytes32 — extract the address from the last 20 bytes
    const recipientBytes32 = decoded[7] as Hex;
    const recipientAddr = ("0x" + recipientBytes32.slice(-40)) as Hex;
    const message = decoded[9] as Hex;

    console.log(
      `[Crosschain] Extracted depositV3 message: recipient=${recipientAddr}, ` +
      `message length=${message.length} chars`,
    );

    return { recipient: recipientAddr, message };
  } catch (err) {
    console.warn(`[Crosschain] depositV3 simulation failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Recursively find a log with a specific topic[0] in a callTracer frame tree. */
function findLogByTopic(frame: CallFrame, topic0: string): TraceLog | null {
  if (frame.logs) {
    for (const log of frame.logs) {
      if (log.topics[0]?.toLowerCase() === topic0.toLowerCase()) {
        return log;
      }
    }
  }
  if (frame.calls) {
    for (const child of frame.calls) {
      const found = findLogByTopic(child, topic0);
      if (found) return found;
    }
  }
  return null;
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
  /** Operator address for depositV3 simulation (extracts destination message) */
  operatorAddress?: Address;
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

  let inputAmountRaw = parseUnits(params.amount, inputToken.decimals);
  let bridgeAmount = params.amount; // may be capped below

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
    // The on-chain MINIMUM_SUPPLY_RATIO = 8 check only applies when
    // totalSupply > 0 (virtual supply cannot exceed 87.5% of total supply).
    // When totalSupply = 0, the ratio check is irrelevant — no cap needed.
    const totalSupply = await getClient(params.srcChainId, params.alchemyKey).readContract({
      address: params.vaultAddress,
      abi: [{ name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const,
      functionName: "totalSupply",
    }).catch(() => 0n) as bigint;
    if (totalSupply > 0n) {
      const maxBridge = (ethBalance * MAX_BRIDGE_FRACTION_NUM) / MAX_BRIDGE_FRACTION_DEN;
      if (inputAmountRaw > maxBridge) {
        inputAmountRaw = maxBridge;
        bridgeAmount = formatUnits(inputAmountRaw, 18);
      }
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
    // Only cap when totalSupply > 0 — see comment above
    const totalSupply = await getClient(params.srcChainId, params.alchemyKey).readContract({
      address: params.vaultAddress,
      abi: [{ name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const,
      functionName: "totalSupply",
    }).catch(() => 0n) as bigint;
    if (totalSupply > 0n) {
      const maxBridge = (balance * MAX_BRIDGE_FRACTION_NUM) / MAX_BRIDGE_FRACTION_DEN;
      if (inputAmountRaw > maxBridge) {
        inputAmountRaw = maxBridge;
        bridgeAmount = formatUnits(inputAmountRaw, inputToken.decimals);
      }
    }
  }

  // Get initial quote (without destination message simulation)
  let quote = await getCrosschainQuote(
    params.srcChainId,
    params.dstChainId,
    params.tokenSymbol,
    bridgeAmount,
  );

  // Build initial calldata — include sourceNativeAmount when using native ETH
  let calldata = buildDepositV3Calldata({
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
    navToleranceBps: TRANSFER_NAV_TOLERANCE_BPS,
    sourceNativeAmount: useNative ? inputAmountRaw : undefined,
    shouldUnwrapOnDestination: params.shouldUnwrapOnDestination,
  });

  // Phase 2: Simulate depositV3 to extract the expanded destination message,
  // then re-quote with accurate gas estimation from the Across API.
  if (params.operatorAddress) {
    const simResult = await simulateDepositV3ForMessage({
      vaultAddress: params.vaultAddress,
      calldata,
      srcChainId: params.srcChainId,
      operatorAddress: params.operatorAddress,
      alchemyKey: params.alchemyKey,
    });
    if (simResult) {
      // Re-quote with accurate destination fill simulation
      quote = await getCrosschainQuote(
        params.srcChainId,
        params.dstChainId,
        params.tokenSymbol,
        bridgeAmount,
        { recipient: simResult.recipient as Address, message: simResult.message },
      );
      // Rebuild calldata with the accurate outputAmount
      calldata = buildDepositV3Calldata({
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
        navToleranceBps: TRANSFER_NAV_TOLERANCE_BPS,
        sourceNativeAmount: useNative ? inputAmountRaw : undefined,
        shouldUnwrapOnDestination: params.shouldUnwrapOnDestination,
      });
      console.log("[Crosschain] Re-quoted with simulated destination message");
    }
  }

  const srcName = chainName(params.srcChainId);
  const dstName = chainName(params.dstChainId);
  const description =
    `Bridge ${bridgeAmount} ${quote.inputToken.symbol} from ${srcName} → ${dstName}` +
    ` (receive ~${quote.outputAmount} ${quote.outputToken.symbol}, fee ${quote.feePct}, ${quote.estimatedTime})` +
    (bridgeAmount !== params.amount ? ` [capped to 87.5% of supply — on-chain MINIMUM_SUPPLY_RATIO]` : "");

  return { quote, calldata, description };
}

/**
 * Build a cross-chain sync transaction (OpType.Sync).
 *
 * If amount is not provided, auto-calculates the minimum needed to cover
// ── NAV equalization — deterministic calculation ──────────────────────

/** Result of NAV equalization computation — fully deterministic, no LLM involvement.
 *
 * The algorithm:
 *   1. Read getPoolTokens() + getPool() on both chains → unitaryValue, totalSupply, decimals
 *   2. Normalize to common decimal base: normDec = min(dec_A, dec_B)
 *   3. Determine direction: bridge FROM higher-NAV chain
 *   4. Closed-form formula for exact bridge amount:
 *        X = ts_src × ts_dst × (uv_src − uv_dst) / (10^normDec × (ts_src + ts_dst))
 *      where ts = totalSupply, uv = unitaryValue (all in normalized units)
 *   5. Convert X to bridge token's source-chain decimals
 *   6. Apply constraints (min amount, max 87.5% of balance)
 *   7. Simulate post-bridge NAV on both chains
 */
export interface NavEqualizationResult {
  /** Source chain (bridges FROM here — the higher-NAV side) */
  srcChainId: number;
  /** Destination chain (bridges TO here — the lower-NAV side) */
  dstChainId: number;
  /** Whether the tool auto-swapped the user's source/destination */
  directionAutoSwapped: boolean;

  // ── Pre-bridge state (per chain, at correct pool.decimals) ──
  srcNavFormatted: string;
  dstNavFormatted: string;
  srcEffectiveSupply: string;
  dstEffectiveSupply: string;
  srcTotalValue: string;
  dstTotalValue: string;
  srcDecimals: number;
  dstDecimals: number;
  /** Common decimal base used for all cross-chain comparisons */
  normalizedDecimals: number;

  // ── Divergence ──
  divergenceBps: number;

  // ── Computed bridge ──
  bridgeToken: BridgeableToken;
  bridgeAmountFormatted: string;
  bridgeAmountRaw: bigint;

  // ── Post-bridge simulation (all in normalizedDecimals) ──
  postSrcNav: string;
  postDstNav: string;
  targetNav: string;
  postDivergenceBps: number;

  /** When true, bridge amount was constrained */
  capped: boolean;
  capReason?: string;
}

/**
 * Compute the exact bridge amount to equalize NAV across two chains.
 *
 * This is a PURE DETERMINISTIC computation — no LLM interpretation.
 * The LLM's only job is to pass the two chain IDs and equalizeNav=true.
 *
 * Handles decimal differences between chains (e.g., USDT is 6-dec on
 * Arbitrum but 18-dec on BSC). Uses updateUnitaryValue() simulation to read
 * the EFFECTIVE pool state (accounts for virtual supply from crosschain
 * transfers), then normalizes to a common decimal base.
 *
 * Uses updateUnitaryValue() instead of getPoolTokens() because:
 *   - getPoolTokens().totalSupply = 0 when all supply is from crosschain
 *     transfers (virtual supply only). updateUnitaryValue() computes the
 *     LIVE NAV including virtual supply → we derive effectiveSupply from it.
 *   - updateUnitaryValue() is a write function but we call it via eth_call
 *     (no state change) to read the live-computed netTotalValue + unitaryValue.
 *
 * Closed-form formula (using total value directly):
 *   Post-bridge NAV equality constraint:
 *     (tv_src − X) / es_src = (tv_dst + X) / es_dst
 *   Solving for X (normalized value units):
 *     X = (es_dst × tv_src − es_src × tv_dst) / (es_src + es_dst)
 *
 * The formula gives the EXACT amount that makes both chains' NAV per pool
 * token equal. Subject to constraints: min bridge amount (relay fees),
 * max 87.5% of balance, available balance.
 */
export async function computeNavEqualization(params: {
  vaultAddress: Address;
  /** User's intended source chain (may be auto-swapped) */
  userSrcChainId: number;
  /** User's intended destination chain (may be auto-swapped) */
  userDstChainId: number;
  preferredToken?: string;
  alchemyKey?: string;
}): Promise<NavEqualizationResult> {
  // 1. Read effective pool state on both chains in parallel
  // Uses updateUnitaryValue() simulation to get live NAV including virtual supply
  const [stateA, stateB] = await Promise.all([
    getEffectivePoolState(params.userSrcChainId, params.vaultAddress, params.alchemyKey),
    getEffectivePoolState(params.userDstChainId, params.vaultAddress, params.alchemyKey),
  ]);

  if (stateA.effectiveSupply === 0n && stateB.effectiveSupply === 0n) {
    throw new Error("Both chains have zero effective supply. Nothing to equalize.");
  }
  if (stateA.effectiveSupply === 0n || stateB.effectiveSupply === 0n) {
    const zeroChain = stateA.effectiveSupply === 0n ? params.userSrcChainId : params.userDstChainId;
    throw new Error(
      `${chainName(zeroChain)} has zero effective supply. NAV equalization requires active pools on both chains.`,
    );
  }

  // 2. Normalize to common decimal base
  // pool.decimals may differ between chains because the same token (USDT)
  // has different decimals on different chains (6 on Arbitrum, 18 on BSC).
  const normDec = Math.min(stateA.decimals, stateB.decimals);
  const scaleA = 10n ** BigInt(stateA.decimals - normDec);
  const scaleB = 10n ** BigInt(stateB.decimals - normDec);
  const normDecPow = 10n ** BigInt(normDec);

  const normUvA = stateA.unitaryValue / scaleA;
  const normUvB = stateB.unitaryValue / scaleB;

  // 3. Determine direction: bridge FROM higher-NAV chain TO lower-NAV chain
  const aIsHigher = normUvA >= normUvB;
  const srcChainId = aIsHigher ? params.userSrcChainId : params.userDstChainId;
  const dstChainId = aIsHigher ? params.userDstChainId : params.userSrcChainId;
  const srcState = aIsHigher ? stateA : stateB;
  const dstState = aIsHigher ? stateB : stateA;
  const srcScale = aIsHigher ? scaleA : scaleB;
  const dstScale = aIsHigher ? scaleB : scaleA;
  const directionAutoSwapped = srcChainId !== params.userSrcChainId;

  const normSrcUv = srcState.unitaryValue / srcScale;
  const normDstUv = dstState.unitaryValue / dstScale;

  // Normalize effective supply and total value for cross-chain comparison
  const normSrcEs = srcState.effectiveSupply / srcScale;
  const normDstEs = dstState.effectiveSupply / dstScale;
  const normSrcTv = srcState.netTotalValue / srcScale;
  const normDstTv = dstState.netTotalValue / dstScale;

  // 4. Pre-bridge divergence
  const divergenceBps = normSrcUv > 0n
    ? Number((normSrcUv - normDstUv) * 10000n / normSrcUv)
    : 0;

  if (divergenceBps === 0) {
    throw new Error(
      `NAV is already equal on both chains ` +
      `(${formatUnits(stateA.unitaryValue, stateA.decimals)} on ${chainName(params.userSrcChainId)}, ` +
      `${formatUnits(stateB.unitaryValue, stateB.decimals)} on ${chainName(params.userDstChainId)}). ` +
      `No equalization needed.`,
    );
  }

  // 5. Closed-form bridge amount using total value directly
  //
  // Post-bridge equality: (tv_src − X) / es_src == (tv_dst + X) / es_dst
  // Solving: X = (es_dst × tv_src − es_src × tv_dst) / (es_src + es_dst)
  //
  // This formulation uses netTotalValue directly — more robust than the UV-based
  // formula because it handles virtual supply correctly without reconstruction.
  const numerator = normDstEs * normSrcTv - normSrcEs * normDstTv;
  const denominator = normSrcEs + normDstEs;
  const bridgeValueNorm = numerator / denominator;

  // 6. Find bridge token — prefer base token type for exact 1:1 value conversion
  const srcTokens = CROSSCHAIN_TOKENS[srcChainId] || [];
  const dstTokenTypes = new Set((CROSSCHAIN_TOKENS[dstChainId] || []).map(t => t.type));

  // Identify base token type on source chain
  let baseTokenType: BridgeableTokenType | undefined;
  const zeroAddr = "0x0000000000000000000000000000000000000000";
  if (srcState.baseToken.toLowerCase() !== zeroAddr) {
    const match = srcTokens.find(
      t => t.address.toLowerCase() === srcState.baseToken.toLowerCase(),
    );
    if (match) baseTokenType = match.type;
  } else {
    baseTokenType = "WETH"; // native token (ETH/BNB) → WETH
  }

  // Find the best token: prefer base token type, then highest balance
  let candidates = srcTokens.filter(t => dstTokenTypes.has(t.type));
  if (params.preferredToken) {
    const pref = params.preferredToken.toUpperCase();
    const filtered = candidates.filter(t => t.type === pref || t.symbol === pref);
    if (filtered.length > 0) candidates = filtered;
  }

  let bestToken: BridgeableToken | undefined;
  let bestBalance = 0n;
  let isBaseMatch = false;

  for (const candidate of candidates) {
    const { balance } = await getVaultTokenBalance(
      srcChainId, params.vaultAddress, candidate.address, params.alchemyKey,
    ).catch(() => ({ balance: 0n, decimals: candidate.decimals, symbol: candidate.symbol }));

    const isBT = candidate.type === baseTokenType;
    if (isBT && balance > 0n && (!isBaseMatch || balance > bestBalance)) {
      bestToken = candidate;
      bestBalance = balance;
      isBaseMatch = true;
    } else if (!isBT && !isBaseMatch && balance > bestBalance) {
      bestToken = candidate;
      bestBalance = balance;
    }
  }

  if (!bestToken || bestBalance === 0n) {
    const available = candidates.map(t => t.symbol).join(", ");
    throw new Error(
      `No bridgeable token with balance on ${chainName(srcChainId)} for NAV equalization. ` +
      `Checked: ${available || "none bridgeable"}.`,
    );
  }

  // 7. Convert normalized value to bridge token amount (source chain decimals)
  //
  // bridgeValueNorm is in normDec-unit value. The bridge token's economic
  // denomination matches the pool's base token (1:1 for stablecoins).
  // Scale to the bridge token's native decimals on the source chain:
  //   bridgeAmount = bridgeValueNorm × 10^(bridgeTokenDec − normDec)
  const bridgeTokenDec = bestToken.decimals;
  let bridgeAmountRaw: bigint;
  if (bridgeTokenDec >= normDec) {
    bridgeAmountRaw = bridgeValueNorm * (10n ** BigInt(bridgeTokenDec - normDec));
  } else {
    bridgeAmountRaw = bridgeValueNorm / (10n ** BigInt(normDec - bridgeTokenDec));
  }

  // 8. Apply constraints (max cap only — no minimum floor)
  // If the amount is too small for the Across solver, the API returns
  // isAmountTooLow=true and the on-chain OutputAmountTooLow revert guards it.
  let capped = false;
  let capReason: string | undefined;

  const maxRaw = bestBalance * MAX_BRIDGE_FRACTION_NUM / MAX_BRIDGE_FRACTION_DEN;
  if (bridgeAmountRaw > maxRaw) {
    bridgeAmountRaw = maxRaw;
    capped = true;
    capReason = `Capped at 87.5% of balance (${formatUnits(bestBalance, bridgeTokenDec)} ${bestToken.symbol})`;
  }
  if (bridgeAmountRaw > bestBalance) {
    bridgeAmountRaw = bestBalance;
    capped = true;
    capReason = `Capped at available balance (${formatUnits(bestBalance, bridgeTokenDec)} ${bestToken.symbol})`;
  }

  // 9. Post-bridge NAV simulation
  // Convert actual bridge amount back to normalized units
  let actualBridgeValueNorm: bigint;
  if (bridgeTokenDec >= normDec) {
    actualBridgeValueNorm = bridgeAmountRaw / (10n ** BigInt(bridgeTokenDec - normDec));
  } else {
    actualBridgeValueNorm = bridgeAmountRaw * (10n ** BigInt(normDec - bridgeTokenDec));
  }

  // Use netTotalValue directly for post-bridge simulation
  const post_tv_src = normSrcTv - actualBridgeValueNorm;
  const post_tv_dst = normDstTv + actualBridgeValueNorm;

  const postSrcUv = normSrcEs > 0n ? post_tv_src * normDecPow / normSrcEs : 0n;
  const postDstUv = normDstEs > 0n ? post_tv_dst * normDecPow / normDstEs : 0n;
  const targetUv = (normSrcEs + normDstEs) > 0n
    ? (normSrcTv + normDstTv) * normDecPow / (normSrcEs + normDstEs)
    : 0n;

  const higher = postSrcUv > postDstUv ? postSrcUv : postDstUv;
  const lower = postSrcUv > postDstUv ? postDstUv : postSrcUv;
  const postDivergenceBps = higher > 0n
    ? Number((higher - lower) * 10000n / higher)
    : 0;

  console.log(
    `[NAV equalization] ${chainName(srcChainId)} (dec=${srcState.decimals}) → ${chainName(dstChainId)} (dec=${dstState.decimals}) | ` +
    `normDec=${normDec} | srcUV=${formatUnits(srcState.unitaryValue, srcState.decimals)} dstUV=${formatUnits(dstState.unitaryValue, dstState.decimals)} | ` +
    `effectiveSupply: src=${formatUnits(srcState.effectiveSupply, srcState.decimals)} dst=${formatUnits(dstState.effectiveSupply, dstState.decimals)} | ` +
    `divergence=${divergenceBps}bps | bridge=${formatUnits(bridgeAmountRaw, bridgeTokenDec)} ${bestToken.symbol} | ` +
    `postDiv=${postDivergenceBps}bps${capped ? ` [${capReason}]` : ''}`,
  );

  return {
    srcChainId,
    dstChainId,
    directionAutoSwapped,
    srcNavFormatted: formatUnits(srcState.unitaryValue, srcState.decimals),
    dstNavFormatted: formatUnits(dstState.unitaryValue, dstState.decimals),
    srcEffectiveSupply: formatUnits(srcState.effectiveSupply, srcState.decimals),
    dstEffectiveSupply: formatUnits(dstState.effectiveSupply, dstState.decimals),
    srcTotalValue: formatUnits(srcState.netTotalValue, srcState.decimals),
    dstTotalValue: formatUnits(dstState.netTotalValue, dstState.decimals),
    srcDecimals: srcState.decimals,
    dstDecimals: dstState.decimals,
    normalizedDecimals: normDec,
    divergenceBps,
    bridgeToken: bestToken,
    bridgeAmountFormatted: formatUnits(bridgeAmountRaw, bridgeTokenDec),
    bridgeAmountRaw,
    postSrcNav: formatUnits(postSrcUv, normDec),
    postDstNav: formatUnits(postDstUv, normDec),
    targetNav: formatUnits(targetUv, normDec),
    postDivergenceBps,
    capped,
    capReason,
  };
}

/**
 * Build a cross-chain sync transaction (OpType.Sync).
 *
 * When equalizeNav=true, uses computeNavEqualization() for a mathematically
 * sound, deterministic calculation that accounts for decimal differences
 * between chains. The LLM should NOT pass amount or token — they are computed.
 *
 * When equalizeNav=false (default), sends a minimal amount to propagate
 * NAV state. Picks a bridgeable token available on both chains.
 */
export async function buildCrosschainSync(params: {
  vaultAddress: Address;
  srcChainId: number;
  dstChainId: number;
  tokenSymbol?: string;   // auto-selects if omitted
  amount?: string;        // auto-calculates if omitted
  navToleranceBps?: number;
  equalizeNav?: boolean;
  alchemyKey?: string;
  /** Operator address for depositV3 simulation (extracts destination message) */
  operatorAddress?: Address;
}): Promise<{
  quote: CrosschainQuote;
  calldata: Hex;
  description: string;
  navEqualization?: NavEqualizationResult;
}> {
  if (params.srcChainId === params.dstChainId) {
    throw new Error("Cross-chain sync requires different source and destination chains.");
  }

  // Working variables — overwritten by equalization when it determines direction
  let srcChainId = params.srcChainId;
  let dstChainId = params.dstChainId;
  let tokenSymbol = params.tokenSymbol;
  let amount = params.amount;
  let navEqualization: NavEqualizationResult | undefined;

  // ── NAV equalization: deterministic, decimal-aware calculation ──
  // When equalizeNav=true, computeNavEqualization() handles everything:
  //   - Reads getPoolTokens() + getPool() on both chains for correct per-chain decimals
  //   - Normalizes to common decimal base (handles 6 vs 18 dec differences)
  //   - Auto-corrects direction (bridges FROM higher-NAV chain)
  //   - Closed-form formula: exact bridge amount for price convergence
  //   - Post-bridge NAV simulation for verification
  // The LLM should NOT pass amount or token — they are computed deterministically.
  if (params.equalizeNav) {
    navEqualization = await computeNavEqualization({
      vaultAddress: params.vaultAddress,
      userSrcChainId: params.srcChainId,
      userDstChainId: params.dstChainId,
      preferredToken: params.tokenSymbol,
      alchemyKey: params.alchemyKey,
    });

    // Use the equalization results for the rest of the flow
    srcChainId = navEqualization.srcChainId;
    dstChainId = navEqualization.dstChainId;
    tokenSymbol = navEqualization.bridgeToken.type;
    amount = navEqualization.bridgeAmountFormatted;
  }

  // Auto-select token if still not determined (non-equalization path)
  if (!tokenSymbol) {
    const srcTokens = CROSSCHAIN_TOKENS[srcChainId] || [];
    const dstTokens = new Set(
      (CROSSCHAIN_TOKENS[dstChainId] || []).map((t) => t.type),
    );

    for (const token of srcTokens) {
      if (!dstTokens.has(token.type)) continue;
      const { balance } = await getVaultTokenBalance(
        srcChainId,
        params.vaultAddress,
        token.address,
        params.alchemyKey,
      );
      if (balance > 0n) {
        tokenSymbol = token.type;
        break;
      }
    }
    if (!tokenSymbol) {
      throw new Error(
        `No bridgeable token with sufficient balance found on ${chainName(srcChainId)} ` +
        `for syncing to ${chainName(dstChainId)}.`,
      );
    }
  }

  // Auto-calculate amount if still not provided (fallback for non-equalization)
  if (!amount) {
    const t = findBridgeableToken(srcChainId, tokenSymbol);
    amount = t ? FALLBACK_SYNC_AMOUNTS[t.type] : "2";
  }

  // Verify balance
  const inputToken = findBridgeableToken(srcChainId, tokenSymbol);
  if (!inputToken) {
    throw new Error(`${tokenSymbol} is not bridgeable on chain ${srcChainId}.`);
  }

  const { balance } = await getVaultTokenBalance(
    srcChainId,
    params.vaultAddress,
    inputToken.address,
    params.alchemyKey,
  );
  const inputAmountRaw = parseUnits(amount, inputToken.decimals);
  if (balance < inputAmountRaw) {
    const available = formatUnits(balance, inputToken.decimals);
    throw new Error(
      `Insufficient ${inputToken.symbol} balance on ${chainName(srcChainId)} for sync. ` +
      `Available: ${available}, needed: ${amount}.`,
    );
  }

  // Get Across quote (shared with transfer — same getCrosschainQuote + fee logic)
  let quote = await getCrosschainQuote(
    srcChainId,
    dstChainId,
    tokenSymbol,
    amount,
  );

  const toleranceBps = params.navToleranceBps ?? DEFAULT_NAV_TOLERANCE_BPS;

  // Build initial calldata (shared buildDepositV3Calldata, only opType + tolerance differ)
  let calldata = buildDepositV3Calldata({
    vaultAddress: params.vaultAddress,
    inputToken: quote.inputToken.address,
    outputToken: quote.outputToken.address,
    inputAmount: quote.inputAmountRaw,
    outputAmount: quote.outputAmountRaw,
    destinationChainId: dstChainId,
    quoteTimestamp: quote.fee.quoteTimestamp,
    exclusiveRelayer: quote.fee.exclusiveRelayer,
    exclusivityDeadline: quote.fee.exclusivityDeadline,
    opType: OpType.Sync,
    navToleranceBps: toleranceBps,
  });

  // Phase 2: Simulate depositV3 to extract the expanded destination message,
  // then re-quote with accurate gas estimation from the Across API.
  if (params.operatorAddress) {
    const simResult = await simulateDepositV3ForMessage({
      vaultAddress: params.vaultAddress,
      calldata,
      srcChainId,
      operatorAddress: params.operatorAddress,
      alchemyKey: params.alchemyKey,
    });
    if (simResult) {
      quote = await getCrosschainQuote(
        srcChainId,
        dstChainId,
        tokenSymbol,
        amount,
        { recipient: simResult.recipient as Address, message: simResult.message },
      );
      calldata = buildDepositV3Calldata({
        vaultAddress: params.vaultAddress,
        inputToken: quote.inputToken.address,
        outputToken: quote.outputToken.address,
        inputAmount: quote.inputAmountRaw,
        outputAmount: quote.outputAmountRaw,
        destinationChainId: dstChainId,
        quoteTimestamp: quote.fee.quoteTimestamp,
        exclusiveRelayer: quote.fee.exclusiveRelayer,
        exclusivityDeadline: quote.fee.exclusivityDeadline,
        opType: OpType.Sync,
        navToleranceBps: toleranceBps,
      });
      console.log("[Crosschain] Re-quoted sync with simulated destination message");
    }
  }

  const srcName = chainName(srcChainId);
  const dstName = chainName(dstChainId);
  let description: string;
  if (navEqualization) {
    const eq = navEqualization;
    description = [
      `NAV sync ${srcName} → ${dstName}: ${amount} ${quote.inputToken.symbol}`,
      `Pre-bridge NAV: ${srcName}=${eq.srcNavFormatted} (${eq.srcDecimals}dec), ${dstName}=${eq.dstNavFormatted} (${eq.dstDecimals}dec)`,
      `Divergence: ${(eq.divergenceBps / 100).toFixed(2)}%`,
      `Post-bridge NAV (projected): ${srcName}=${eq.postSrcNav}, ${dstName}=${eq.postDstNav} (target=${eq.targetNav})`,
      `Post-divergence: ${(eq.postDivergenceBps / 100).toFixed(2)}%`,
      `Fee: ${quote.feePct}`,
      eq.capped ? `Note: ${eq.capReason}` : '',
      eq.directionAutoSwapped ? `Direction auto-corrected (bridging from higher-NAV chain)` : '',
    ].filter(Boolean).join(' | ');
  } else {
    description =
      `Sync NAV from ${srcName} → ${dstName} using ${amount} ${quote.inputToken.symbol}` +
      ` (tolerance: ${(toleranceBps / 100).toFixed(2)}%, fee: ${quote.feePct})`;
  }

  return { quote, calldata, description, navEqualization };
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
