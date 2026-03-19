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
 * Amounts are sent to the Across API in the input token's native decimals
 * with `allowUnmatchedDecimals=true` for cross-decimal routes. The Across
 * API returns outputAmount in output token decimals. The on-chain AIntents
 * adapter handles rebasing internally (CrosschainLib._rebaseOutputAmount).
 *
 * @see https://github.com/RigoBlock/v3-contracts/blob/master/contracts/protocol/extensions/adapters/AIntents.sol
 */

import {
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { ACROSS_SPOKE_POOL_ABI } from "../abi/aIntents.js";
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
import { getVaultTokenBalance, getNavData, getPoolData, getClient } from "./vault.js";
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
 * token transfer. Across doesn't know about this overhead (it can't simulate
 * the AIntents adapter), so we deduct it manually from the minimum output
 * the solver must deliver. Without this, solvers won't fill profitably.
 *
 * For stablecoins (USDC/USDT), 1 USD ≈ 1 token unit — deduction is exact.
 * For WETH/WBTC, the overhead is negligible relative to token value — no deduction.
 */
const AINTENTS_GAS_OVERHEAD_USD: Record<number, number> = {
  1:     0.50,   // Ethereum mainnet — high gas costs
  56:    0.15,   // BSC
  137:   0.15,   // Polygon
  10:    0.05,   // Optimism
  8453:  0.05,   // Base
  42161: 0.05,   // Arbitrum
  130:   0.05,   // Unichain
};

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
  inputDecimals: number,
  outputDecimals: number,
): Promise<AcrossFeeQuote> {
  const url = new URL(ACROSS_API);
  url.searchParams.set("inputToken", inputToken);
  url.searchParams.set("outputToken", outputToken);
  url.searchParams.set("originChainId", srcChainId.toString());
  url.searchParams.set("destinationChainId", dstChainId.toString());
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("skipAmountLimit", "true");

  // BSC USDC/USDT are 18 decimals while other chains use 6.
  // The Across API requires this flag for cross-decimal routes.
  if (inputDecimals !== outputDecimals) {
    url.searchParams.set("allowUnmatchedDecimals", "true");
  }

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
 * returns outputAmount in the output token's native decimals. For BSC
 * USDC/USDT (18 decimals vs 6 on other chains), the `allowUnmatchedDecimals`
 * flag is required.
 *
 * The on-chain AIntents adapter handles decimal rebasing internally
 * (CrosschainLib._rebaseOutputAmount) — we pass amounts as-is.
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

  // Fetch suggested fees — amount in input token native decimals
  const fee = await getAcrossSuggestedFees(
    srcChainId,
    dstChainId,
    inputToken.address,
    outputToken.address,
    inputAmountRaw,
    inputToken.decimals,
    outputToken.decimals,
  );

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

  // Across API returns outputAmount in output token's native decimals.
  // Deduct the AIntents gas overhead (handleV3AcrossMessage: NAV calc + donate)
  // that the solver must pay on the destination chain. Across doesn't model
  // the AIntents adapter, so without this the outputAmount is too high and
  // solvers won't fill profitably.
  // Applied to stablecoins only (USDC/USDT ≈ 1 USD per unit).
  let outputAmountRaw = fee.outputAmountRaw;
  if (outputToken.type === "USDC" || outputToken.type === "USDT") {
    const overheadUsd = AINTENTS_GAS_OVERHEAD_USD[dstChainId] ?? 0.05;
    const overheadRaw = parseUnits(overheadUsd.toFixed(6), outputToken.decimals);
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

  // Get quote
  const quote = await getCrosschainQuote(
    params.srcChainId,
    params.dstChainId,
    params.tokenSymbol,
    bridgeAmount,
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
    navToleranceBps: TRANSFER_NAV_TOLERANCE_BPS,
    sourceNativeAmount: useNative ? inputAmountRaw : undefined,
    shouldUnwrapOnDestination: params.shouldUnwrapOnDestination,
  });

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
