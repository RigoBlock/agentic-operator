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
 * ## Multi-chain NAV calculation
 * Each chain's NAV is computed locally from `updateUnitaryValue()` and converted
 * to chain-local USDC via the BackgeoOracle. A single unit-less global target
 * unitary is derived from:
 *   target = Σ(total USDC) / Σ(USDC value of effective supplies)
 * where for each chain:
 *   supplyValueUsdc = totalUsdcNormalized × 10^baseTokenDecimals / unitaryValue
 * The target has no unit; it is interpreted on each chain as the target number
 * of base-token units per pool token (e.g. 2.45 ETH on Ethereum, 2.45 POL on
 * Polygon, 2.45 BNB on BSC). NAV sync moves value from chains above the target
 * to chains below the target, using stablecoins when base assets differ.
 *
 * NOTE: The oracle conversions use spot prices (`observe([0,1])`), not TWAP.
 * This is acceptable for the off-chain NAV aggregation and rebalancing use case
 * because the on-chain NAV shield and swap shield still enforce their own
 * slippage/TWAP protections at execution time.
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
  decodeFunctionResult,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { ACROSS_SPOKE_POOL_ABI } from "../abi/aIntents.js";
import { ERC20_ABI } from "../abi/erc20.js";
import { getRpcUrl, getNativeTokenSymbol, getWrappedNativeAddress } from "../config.js";
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
import { getVaultTokenBalance, getVaultTokenBalancesBulk } from "./vault.js";
import type { EffectivePoolState } from "./vault.js";
import { getClient } from "./rpcClient.js";
import { convertTokenAmountViaOracle } from "./oraclePrice.js";
import { getDelegationConfig, getActiveChains } from "./delegation.js";
import { mapWithConcurrency, mapWithConcurrencySettled } from "./concurrency.js";
import type { DelegationConfig } from "../types.js";

// ── Constants

/** Maximum bridge fee as bps (2% — hard-coded in AIntents.sol as MAX_BRIDGE_FEE_BPS) */
const MAX_BRIDGE_FEE_BPS = 200;

/** Default fill deadline window: 6 hours from quote timestamp */
const DEFAULT_FILL_DEADLINE_SECS = 6 * 60 * 60; // 21 600

/** Default NAV tolerance for Sync ops (100 bps = 1%) */
const DEFAULT_NAV_TOLERANCE_BPS = 100;

// NOTE: There is NO off-chain cap on bridge amount for Transfer ops.
// The on-chain contract enforces NavImpactLib.MINIMUM_SUPPLY_RATIO = 20
// (effective supply must stay ≥ totalSupply / 20 after bridging).
// If the user tries to bridge too much, the pre-broadcast simulation
// catches EffectiveSupplyTooLow and surfaces it. We do NOT attempt to
// replicate the virtual-supply math off-chain — it depends on live NAV
// and pool-share calculations that are complex and error-prone.

/** Across suggested-fees API base URL */
const ACROSS_API = "https://app.across.to/api/suggested-fees";

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
  /** Total pool token supply (in pool decimals) */
  totalSupply: bigint;
  /** Effective supply = totalSupply + virtualSupply, computed from netTotalValue / unitaryValue */
  effectiveSupply: bigint;
  /** Pool base token address on this chain */
  baseToken: Address;
  /** Pool base token symbol (ETH, WETH, POL, etc.) */
  baseTokenSymbol: string;
  /** Pool base token decimals */
  baseTokenDecimals: number;
  /** Total pool value converted to USDC and normalized to 6 decimals via the oracle */
  totalUsdcNormalized: bigint;
  /** USDC value of this chain's effective supply: totalUsdcNormalized * 10^baseTokenDecimals / unitaryValue */
  supplyValueUsdc: bigint;
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
  /** Cross-chain total NAV in USDC, computed from each chain's on-chain netTotalValue
   *  converted to chain-local USDC via the oracle and normalized to 6 decimals. */
  globalNav: {
    /** Total vault assets across all chains in normalized USDC. */
    totalUsdc: string;
    /** Unit-less global target price. Interpreted on each chain as the
     *  target number of base-token units per pool token. */
    targetPrice: string;
    /** Total USDC value of all effective supplies across all chains. Used as the
     *  denominator for the global target unitary. */
    totalSupplyValueUsdc: string;
  };
}

/** A single bridge operation recommended by the rebalancer */
/** Maximum bridge fraction of a chain's value in a single rebalance.
 *  Conservative cap (50%) to avoid draining a chain in one operation.
 *  The on-chain MINIMUM_SUPPLY_RATIO = 20 allows up to 95%, but we
 *  keep rebalance ops smaller for safety. */
const MAX_REBALANCE_BRIDGE_PCT = 50n;

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

  // Read NAV + balances across chains with bounded concurrency to avoid
  // spiking Alchemy compute-unit throughput.
  const chainIds = Object.keys(CROSSCHAIN_TOKENS).map(Number);
  const snapshots = await mapWithConcurrency(
    chainIds,
    (chainId) => readChainSnapshot(vaultAddress, chainId, alchemyKey, activeChains.has(chainId)),
  );

  // Any active chain that failed oracle pricing makes the global NAV unreliable.
  // Fail fast rather than silently dropping a chain.
  const pricingErrors = snapshots.filter((s) => s.error && s.effectiveSupply > 0n);
  if (pricingErrors.length > 0) {
    const details = pricingErrors.map((s) => `${s.chainName}: ${s.error}`).join("; ");
    throw new Error(`Cannot compute global NAV: ${details}`);
  }

  // Compute a unit-less global target unitary value.
  // Each chain's NAV is denominated in its own base token. We convert both the
  // total value and the effective supply to USDC via the oracle, then divide:
  //   globalUnitary = Σ(totalUsdc_i) / Σ(supplyValueUsdc_i)
  // where supplyValueUsdc_i = totalUsdc_i * 10^baseTokenDecimals / unitaryValue_i.
  // The result has no unit; it is interpreted on each chain as the target number
  // of base-token units per pool token (e.g. 2.45 ETH on Ethereum, 2.45 POL on Polygon).
  const GLOBAL_UNITARY_PRECISION = 18;
  let totalUsdcNormalized = 0n;
  let totalSupplyValueUsdc = 0n;

  for (const snap of snapshots) {
    if (snap.error || snap.effectiveSupply === 0n || snap.totalUsdcNormalized === 0n || snap.unitaryValue === 0n) {
      continue;
    }
    const supplyValueUsdc = (snap.totalUsdcNormalized * (10n ** BigInt(snap.baseTokenDecimals))) / snap.unitaryValue;
    snap.supplyValueUsdc = supplyValueUsdc;
    totalUsdcNormalized += snap.totalUsdcNormalized;
    totalSupplyValueUsdc += supplyValueUsdc;
  }

  const globalUnitaryRaw = totalSupplyValueUsdc > 0n
    ? (totalUsdcNormalized * (10n ** BigInt(GLOBAL_UNITARY_PRECISION))) / totalSupplyValueUsdc
    : 0n;

  const missingDelegationChains = snapshots
    .filter((s) => !s.delegationActive && !s.error && (s.totalValue > 0n || s.effectiveSupply > 0n))
    .map((s) => s.chainId);

  return {
    vaultAddress,
    chains: snapshots,
    missingDelegationChains,
    globalNav: {
      totalUsdc: formatUnits(totalUsdcNormalized, 6),
      targetPrice: formatUnits(globalUnitaryRaw, GLOBAL_UNITARY_PRECISION),
      totalSupplyValueUsdc: formatUnits(totalSupplyValueUsdc, 6),
    },
  };
}

/** Normalize a bigint amount from one decimal scale to another. */
export function normalizeToDecimals(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return value;
  if (fromDecimals > toDecimals) return value / (10n ** BigInt(fromDecimals - toDecimals));
  return value * (10n ** BigInt(toDecimals - fromDecimals));
}

/** Resolve the human-readable symbol for a vault's base token on a given chain. */
function getBaseTokenSymbol(chainId: number, baseToken: Address): string {
  const zeroAddr = "0x0000000000000000000000000000000000000000";
  if (baseToken.toLowerCase() === zeroAddr) {
    return getNativeTokenSymbol(chainId);
  }
  const bridgeableTokens = CROSSCHAIN_TOKENS[chainId] || [];
  const match = bridgeableTokens.find(
    (t) => t.address.toLowerCase() === baseToken.toLowerCase(),
  );
  return match?.symbol || "ERC20";
}

/**
 * Determine whether two base tokens on two chains represent the same asset.
 * - Native tokens (zero address) are compared by native symbol (ETH, BNB, POL, ...).
 * - Non-native tokens are compared by exact address.
 * No canonical wrapping assumptions are made.
 */
function isNativeBaseToken(chainId: number, baseToken: Address): boolean {
  const zeroAddr = "0x0000000000000000000000000000000000000000";
  if (baseToken.toLowerCase() === zeroAddr) return true;
  const wrapped = getWrappedNativeAddress(chainId);
  return wrapped ? baseToken.toLowerCase() === wrapped.toLowerCase() : false;
}

export function sameBaseAsset(chainIdA: number, baseA: Address, chainIdB: number, baseB: Address): boolean {
  const aIsNative = isNativeBaseToken(chainIdA, baseA);
  const bIsNative = isNativeBaseToken(chainIdB, baseB);
  if (aIsNative && bIsNative) {
    return getNativeTokenSymbol(chainIdA) === getNativeTokenSymbol(chainIdB);
  }
  if (!aIsNative && !bIsNative) {
    return baseA.toLowerCase() === baseB.toLowerCase();
  }
  return false;
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
  const zeroAddr = "0x0000000000000000000000000000000000000000" as Address;
  try {
    // Read the effective pool state via updateUnitaryValue simulation (same method
    // the NAV sync tool uses), the actual ERC-20 totalSupply, and all bridgeable
    // token balances in parallel.
    const bridgeableTokens = CROSSCHAIN_TOKENS[chainId] || [];
    const client = getClient(chainId, alchemyKey);

    // Build one multicall per chain: pool state (updateUnitaryValue + getPool),
    // totalSupply, and all bridgeable token balances. This replaces the previous
    // fan-out where each token triggered its own RPC round-trip.
    const calls = [
      {
        address: vaultAddress,
        abi: RIGOBLOCK_VAULT_ABI,
        functionName: "updateUnitaryValue",
      },
      {
        address: vaultAddress,
        abi: RIGOBLOCK_VAULT_ABI,
        functionName: "getPool",
      },
      {
        address: vaultAddress,
        abi: RIGOBLOCK_VAULT_ABI,
        functionName: "totalSupply",
      },
      ...bridgeableTokens.map((token) => ({
        address: token.address,
        abi: ERC20_ABI,
        functionName: "balanceOf" as const,
        args: [vaultAddress],
      })),
    ];

    const results = await client.multicall({ contracts: calls, allowFailure: true });

    // Decode pool state from the first two multicall results.
    // With allowFailure: true, viem returns decoded results directly.
    let state: EffectivePoolState | null = null;
    const updateResult = results[0];
    const poolResult = results[1];
    if (updateResult.status === "success" && poolResult.status === "success") {
      const nav = updateResult.result as {
        unitaryValue: bigint;
        netTotalValue: bigint;
        netTotalLiabilities: bigint;
      };
      const pool = poolResult.result as {
        name: string;
        symbol: string;
        decimals: number;
        owner: Address;
        baseToken: Address;
      };
      const dec = Number(pool.decimals);
      const decPow = 10n ** BigInt(dec);
      state = {
        unitaryValue: nav.unitaryValue,
        netTotalValue: nav.netTotalValue,
        effectiveSupply: nav.unitaryValue > 0n
          ? (nav.netTotalValue * decPow) / nav.unitaryValue
          : 0n,
        decimals: dec,
        baseToken: pool.baseToken,
      };
    }

    const totalSupplyResult = results[2];
    const totalSupplyRaw = totalSupplyResult.status === "success"
      ? (totalSupplyResult.result as bigint)
      : 0n;

    const tokenBalances: TokenBalance[] = bridgeableTokens.map((token, i) => {
      const result = results[i + 3];
      const balance = result.status === "success" ? (result.result as bigint) : 0n;
      return {
        token,
        balance,
        balanceFormatted: formatUnits(balance, token.decimals),
      };
    }).filter((b) => b.balance > 0n);

    if (!state) {
      return {
        chainId,
        chainName: name,
        unitaryValue: 0n,
        totalValue: 0n,
        totalSupply: totalSupplyRaw as bigint,
        effectiveSupply: 0n,
        baseToken: zeroAddr,
        baseTokenSymbol: tokenBalances.length > 0 ? "UNKNOWN" : "N/A",
        baseTokenDecimals: 18,
        totalUsdcNormalized: 0n,
        supplyValueUsdc: 0n,

        tokenBalances,
        delegationActive,
      };
    }

    // Determine base token symbol from on-chain data.
    // Decimals come from on-chain pool data; symbol is derived from the base token
    // address (zero address = native token).
    const baseTokenSymbol = getBaseTokenSymbol(chainId, state.baseToken);

    // Convert the chain's total value (in base token) to normalized USDC (6 dec)
    // via the on-chain oracle. If no USDC exists or the oracle has no feed for
    // the base token, mark this chain as errored rather than inventing a price.
    let totalUsdcNormalized = 0n;
    if (state.netTotalValue > 0n) {
      const usdcToken = CROSSCHAIN_TOKENS[chainId]?.find((t) => t.type === "USDC");
      if (!usdcToken) {
        return {
          chainId,
          chainName: name,
          unitaryValue: state.unitaryValue,
          totalValue: state.netTotalValue,
          totalSupply: totalSupplyRaw as bigint,
          effectiveSupply: state.effectiveSupply,
          baseToken: state.baseToken,
          baseTokenSymbol,
          baseTokenDecimals: state.decimals,
          totalUsdcNormalized: 0n,
          supplyValueUsdc: 0n,
  
          tokenBalances,
          delegationActive,
          error: `No USDC configured on chain ${chainId} — cannot price base token ${baseTokenSymbol}`,
        };
      }
      try {
        const totalUsdcRaw = await convertTokenAmountViaOracle(
          chainId,
          state.baseToken,
          state.netTotalValue,
          usdcToken.address,
          alchemyKey,
        );
        totalUsdcNormalized = normalizeToDecimals(totalUsdcRaw, usdcToken.decimals, 6);
      } catch (err) {
        return {
          chainId,
          chainName: name,
          unitaryValue: state.unitaryValue,
          totalValue: state.netTotalValue,
          totalSupply: totalSupplyRaw as bigint,
          effectiveSupply: state.effectiveSupply,
          baseToken: state.baseToken,
          baseTokenSymbol,
          baseTokenDecimals: state.decimals,
          totalUsdcNormalized: 0n,
          supplyValueUsdc: 0n,
  
          tokenBalances,
          delegationActive,
          error: `Oracle pricing failed for ${baseTokenSymbol}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return {
      chainId,
      chainName: name,
      unitaryValue: state.unitaryValue,
      totalValue: state.netTotalValue,
      totalSupply: totalSupplyRaw as bigint,
      effectiveSupply: state.effectiveSupply,
      baseToken: state.baseToken,
      baseTokenSymbol,
      baseTokenDecimals: state.decimals,
      totalUsdcNormalized,
      supplyValueUsdc: 0n,
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
      effectiveSupply: 0n,
      baseToken: zeroAddr,
      baseTokenSymbol: "N/A",
      baseTokenDecimals: 18,
      totalUsdcNormalized: 0n,
      supplyValueUsdc: 0n,
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

        // Cap at 50% of chain value to avoid draining a chain in one rebalance op.
        // The on-chain MINIMUM_SUPPLY_RATIO = 20 allows up to 95%, but we stay
        // conservative for rebalancing.
        if (pct > MAX_REBALANCE_BRIDGE_PCT) {
          const safeNormalised = (totalChainValue * MAX_REBALANCE_BRIDGE_PCT) / 100n;
          bridgeAmount = safeNormalised / (10n ** (18n - BigInt(bal.token.decimals)));
          const divisor = 10n ** BigInt(bal.token.decimals);
          const whole = bridgeAmount / divisor;
          const frac = (bridgeAmount % divisor).toString().padStart(bal.token.decimals, "0").slice(0, 6);
          bridgeFormatted = `${whole}.${frac}`;
          capped = true;
          impactPct = `~${MAX_REBALANCE_BRIDGE_PCT}% (capped from ${pct}%)`;
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

  // Fetch fee estimates with bounded concurrency to avoid a burst of Across API calls.
  await mapWithConcurrency(
    operations,
    async (op) => {
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
    },
  );

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
 * (WETH/WBTC), the USD overhead is converted to token units using a static
 * conservative USD price floor (no external API call).
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

/**
 * Static conservative USD price floor for bridgeable token types.
 * Used only for the AIntents gas-overhead deduction. Values are intentionally
 * LOW so we deduct MORE tokens as overhead, giving the solver margin.
 * Stablecoins use 1. No external API call is made.
 */
function getStaticTokenPriceFloor(tokenType: BridgeableTokenType): number {
  switch (tokenType) {
    case "USDC":
    case "USDT":
      return 1;
    case "WBTC":
      return 30000;
    case "WETH":
    default:
      return 1000;
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

  // Fetch suggested fees. Token price is a static conservative floor used only
  // for the AIntents gas-overhead deduction (no external price API).
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
    simulatedFill ? Promise.resolve(1) : getStaticTokenPriceFloor(outputToken.type),
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
  /** True if the requested amount was capped due to on-chain MINIMUM_SUPPLY_RATIO */
  wasCapped: boolean;
  /** Original amount requested by the user */
  requestedAmount: string;
  /** Actual amount after capping (same as quote.inputAmount) */
  cappedAmount: string;
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
    // No off-chain cap — the on-chain contract enforces MINIMUM_SUPPLY_RATIO = 20.
    // If the amount exceeds the limit, eth_call simulation catches EffectiveSupplyTooLow.
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
    navToleranceBps: DEFAULT_NAV_TOLERANCE_BPS,
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
        navToleranceBps: DEFAULT_NAV_TOLERANCE_BPS,
        sourceNativeAmount: useNative ? inputAmountRaw : undefined,
        shouldUnwrapOnDestination: params.shouldUnwrapOnDestination,
      });
    }
  }

  const srcName = chainName(params.srcChainId);
  const dstName = chainName(params.dstChainId);
  const description =
    `Bridge ${bridgeAmount} ${quote.inputToken.symbol} from ${srcName} → ${dstName}` +
    ` (receive ~${quote.outputAmount} ${quote.outputToken.symbol}, fee ${quote.feePct}, ${quote.estimatedTime})`;

  return {
    quote,
    calldata,
    description,
    wasCapped: false,
    requestedAmount: params.amount,
    cappedAmount: bridgeAmount,
  };
}

/**
 * Build a cross-chain sync transaction (OpType.Sync).
 *
 * If amount is not provided, auto-calculates the minimum needed to cover
// ── NAV equalization — deterministic calculation ──────────────────────

/** Result of NAV equalization computation — fully deterministic, no LLM involvement.
 *
 * Algorithm (global unit-less target unitary):
 *   1. Read aggregated NAV for the vault via getAggregatedNav().
 *   2. Compute the global target unitary as a unit-less ratio:
 *        target = Σ(total USDC) / Σ(USDC value of effective supplies)
 *   3. For the requested pair, compute each chain's deviation from target in USDC:
 *        deviation = chain total USDC − target × chain supplyValueUsdc
 *   4. Direction: bridge FROM the chain with positive deviation (above target)
 *      TO the chain with negative deviation (below target).
 *   5. Bridge amount in USDC = min(source excess, −destination deficit) so the
 *      operation never overshoots the global target for either chain.
 *   6. Convert the USDC bridge amount to the chosen bridge token via the oracle.
 *   7. Cap to available vault balance on the source chain.
 *   8. Simulate post-bridge NAV for verification.
 *
 * The global target is unit-less: 2.45 means 2.45 ETH per pool token on an ETH
 * chain and 2.45 POL per pool token on a POL chain. This matches the model where
 * each chain computes NAV in its own base token and cross-chain sync converges
 * the numeric unitary value across all chains.
 */
export interface NavEqualizationResult {
  /** Source chain (bridges FROM here — the chain above the global target) */
  srcChainId: number;
  /** Destination chain (bridges TO here — the chain below the global target) */
  dstChainId: number;
  /** Whether the tool auto-swapped the user's source/destination */
  directionAutoSwapped: boolean;

  /** Unit-less global target price */
  targetPrice: string;

  // ── Pre-bridge state (base-token prices) ──
  srcPrice: string;
  dstPrice: string;
  srcBaseTokenSymbol: string;
  dstBaseTokenSymbol: string;
  srcEffectiveSupply: string;
  dstEffectiveSupply: string;
  srcTotalUsdc: string;
  dstTotalUsdc: string;
  srcDeviationUsdc: string;
  dstDeviationUsdc: string;

  // ── Divergence from global target ──
  divergenceBps: number;

  // ── Computed bridge ──
  bridgeToken: BridgeableToken;
  bridgeAmountFormatted: string;
  bridgeAmountRaw: bigint;
  bridgeAmountUsdc: string;

  // ── Post-bridge simulation (base-token prices) ──
  postSrcPrice: string;
  postDstPrice: string;
  postDivergenceBps: number;

  /** When true, bridge amount was constrained */
  capped: boolean;
  capReason?: string;
}

/**
 * Project the NAV impact of a single explicit-amount sync on the source chain.
 *
 * Simulates multicall([depositV3, updateUnitaryValue]) on the source chain to
 * obtain the post-sync unitary value. Returns pre/post values and the signed
 * impact percentage (negative = NAV dropped).
 */
export async function projectSyncNavImpact(params: {
  vaultAddress: Address;
  srcChainId: number;
  depositV3Calldata: Hex;
  operatorAddress?: Address;
  alchemyKey?: string;
}): Promise<{
  preUnitaryValue: string;
  postUnitaryValue: string;
  impactPct: string;
} | undefined> {
  const publicClient = getClient(params.srcChainId, params.alchemyKey);
  const sender = params.operatorAddress ?? params.vaultAddress;

  // Pre-sync NAV
  let preNav: bigint;
  try {
    const preCall = await publicClient.call({
      to: params.vaultAddress,
      data: encodeFunctionData({
        abi: RIGOBLOCK_VAULT_ABI,
        functionName: "updateUnitaryValue",
      }),
    });
    if (!preCall.data) return undefined;
    const preResult = decodeFunctionResult({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "updateUnitaryValue",
      data: preCall.data,
    }) as { unitaryValue: bigint; netTotalValue: bigint; netTotalLiabilities: bigint };
    preNav = preResult.unitaryValue;
  } catch {
    return undefined;
  }

  if (preNav === 0n) {
    return {
      preUnitaryValue: "0",
      postUnitaryValue: "0",
      impactPct: "0",
    };
  }

  // Post-sync NAV via multicall([depositV3, updateUnitaryValue])
  try {
    const navCalldata = encodeFunctionData({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "updateUnitaryValue",
    });
    const multicallData = encodeFunctionData({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "multicall",
      args: [[params.depositV3Calldata, navCalldata]],
    });
    const postCall = await publicClient.call({
      account: sender,
      to: params.vaultAddress,
      data: multicallData,
      value: 0n,
    });
    if (!postCall.data) return undefined;
    const postResults = decodeFunctionResult({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "multicall",
      data: postCall.data,
    }) as readonly Hex[];
    const postNavResult = decodeFunctionResult({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "updateUnitaryValue",
      data: postResults[1],
    }) as { unitaryValue: bigint; netTotalValue: bigint; netTotalLiabilities: bigint };
    const postNav = postNavResult.unitaryValue;
    const impactBps = ((postNav - preNav) * 10000n) / preNav;
    return {
      preUnitaryValue: preNav.toString(),
      postUnitaryValue: postNav.toString(),
      impactPct: (Number(impactBps) / 100).toFixed(4),
    };
  } catch {
    return undefined;
  }
}

/**
 * Compute the bridge amount needed to move two chains toward their shared
 * per-base-asset group target NAV.
 *
 * This is a PURE DETERMINISTIC computation — no LLM interpretation.
 * The caller only has to pass the two chain IDs; the algorithm derives the
 * direction, token, and amount from live pool state.
 *
 * Uses getAggregatedNav() to read the full multi-chain state and compute the
 * group target in USDC as the common denominator. NAV sync only makes sense
 * between chains that share the same base asset (ETH↔ETH, USDC↔USDC, ...).
 *
 * The bridge amount in USDC is:
 *   bridgeUsdc = min(srcDeviation, −dstDeviation)
 * where deviation = chain total USDC − targetUnitaryUsdc × chain normalized supply.
 * This avoids overshooting the group target for either chain.
 *
 * Subject to constraints: available vault balance on the source chain,
 * minimum bridge amount imposed by the Across solver, and the on-chain
 * MINIMUM_SUPPLY_RATIO.
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
  if (params.userSrcChainId === params.userDstChainId) {
    throw new Error("NAV equalization requires two different chains.");
  }

  const GLOBAL_UNITARY_PRECISION = 18;

  // 1. Read aggregated NAV to obtain the global unit-less target price.
  const nav = await getAggregatedNav(
    params.vaultAddress,
    params.alchemyKey ?? "",
  );

  const srcSnap = nav.chains.find((s) => s.chainId === params.userSrcChainId);
  const dstSnap = nav.chains.find((s) => s.chainId === params.userDstChainId);

  if (!srcSnap) {
    throw new Error(`No NAV data for source chain ${chainName(params.userSrcChainId)}.`);
  }
  if (!dstSnap) {
    throw new Error(`No NAV data for destination chain ${chainName(params.userDstChainId)}.`);
  }
  if (srcSnap.error) {
    throw new Error(`Cannot read NAV for ${chainName(params.userSrcChainId)}: ${srcSnap.error}`);
  }
  if (dstSnap.error) {
    throw new Error(`Cannot read NAV for ${chainName(params.userDstChainId)}: ${dstSnap.error}`);
  }
  if (srcSnap.effectiveSupply === 0n || dstSnap.effectiveSupply === 0n) {
    const zeroChainId = srcSnap.effectiveSupply === 0n ? params.userSrcChainId : params.userDstChainId;
    throw new Error(
      `${chainName(zeroChainId)} has zero effective supply. ` +
      `NAV equalization requires active pools on both chains.`,
    );
  }

  // 2. Compute each chain's deviation from the global target in USDC.
  const globalPriceRaw = parseUnits(nav.globalNav.targetPrice, GLOBAL_UNITARY_PRECISION);
  const targetTotalUsdcSrc = (globalPriceRaw * srcSnap.supplyValueUsdc) / (10n ** BigInt(GLOBAL_UNITARY_PRECISION));
  const targetTotalUsdcDst = (globalPriceRaw * dstSnap.supplyValueUsdc) / (10n ** BigInt(GLOBAL_UNITARY_PRECISION));

  const srcDeviationUsdc = srcSnap.totalUsdcNormalized - targetTotalUsdcSrc;
  const dstDeviationUsdc = dstSnap.totalUsdcNormalized - targetTotalUsdcDst;

  const srcPriceBase = Number(formatUnits(srcSnap.unitaryValue, srcSnap.baseTokenDecimals));
  const dstPriceBase = Number(formatUnits(dstSnap.unitaryValue, dstSnap.baseTokenDecimals));
  const targetPriceBase = Number(nav.globalNav.targetPrice);

  // 3. Determine direction: bridge FROM positive deviation (above target)
  //    TO negative deviation (below target).
  let srcChainId = params.userSrcChainId;
  let dstChainId = params.userDstChainId;
  let srcSnapFinal = srcSnap;
  let dstSnapFinal = dstSnap;
  let srcDeviationFinal = srcDeviationUsdc;
  let dstDeviationFinal = dstDeviationUsdc;
  let srcPriceBaseFinal = srcPriceBase;
  let dstPriceBaseFinal = dstPriceBase;
  let directionAutoSwapped = false;

  if (srcDeviationUsdc > 0n && dstDeviationUsdc < 0n) {
    // Use requested direction.
  } else if (srcDeviationUsdc < 0n && dstDeviationUsdc > 0n) {
    srcChainId = params.userDstChainId;
    dstChainId = params.userSrcChainId;
    srcSnapFinal = dstSnap;
    dstSnapFinal = srcSnap;
    srcDeviationFinal = dstDeviationUsdc;
    dstDeviationFinal = srcDeviationUsdc;
    srcPriceBaseFinal = dstPriceBase;
    dstPriceBaseFinal = srcPriceBase;
    directionAutoSwapped = true;
  } else {
    throw new Error(
      `Both chains are on the same side of the global target (${nav.globalNav.targetPrice}). ` +
      `${chainName(params.userSrcChainId)}: ${srcPriceBase.toFixed(6)} ${srcSnap.baseTokenSymbol}, ` +
      `${chainName(params.userDstChainId)}: ${dstPriceBase.toFixed(6)} ${dstSnap.baseTokenSymbol}. ` +
      `No equalization is possible between these two chains.`,
    );
  }

  // 4. Bridge amount in USDC: don't overshoot either chain.
  const bridgeUsdc = srcDeviationFinal < -dstDeviationFinal
    ? srcDeviationFinal
    : -dstDeviationFinal;

  if (bridgeUsdc <= 0n) {
    throw new Error(
      `Calculated bridge amount is zero. ` +
      `${chainName(srcChainId)} is ${formatUnits(srcDeviationFinal, 6)} USDC above target, ` +
      `${chainName(dstChainId)} is ${formatUnits(-dstDeviationFinal, 6)} USDC below target.`,
    );
  }

  // 5. Select bridge token on source chain.
  const srcTokens = CROSSCHAIN_TOKENS[srcChainId] || [];
  const dstTokenTypes = new Set((CROSSCHAIN_TOKENS[dstChainId] || []).map((t) => t.type));

  // Identify base token type on source chain
  let baseTokenType: BridgeableTokenType | undefined;
  const zeroAddr = "0x0000000000000000000000000000000000000000";
  if (srcSnapFinal.baseToken.toLowerCase() !== zeroAddr) {
    const match = srcTokens.find(
      (t) => t.address.toLowerCase() === srcSnapFinal.baseToken.toLowerCase(),
    );
    if (match) baseTokenType = match.type;
  } else {
    baseTokenType = "WETH"; // native token (ETH/BNB) → WETH
  }

  const crossBaseAsset = !sameBaseAsset(
    srcSnapFinal.chainId, srcSnapFinal.baseToken,
    dstSnapFinal.chainId, dstSnapFinal.baseToken,
  );

  let candidates = srcTokens.filter((t) => dstTokenTypes.has(t.type));
  if (params.preferredToken) {
    const pref = params.preferredToken.toUpperCase();
    const filtered = candidates.filter((t) => t.type === pref || t.symbol === pref);
    if (filtered.length > 0) candidates = filtered;
  }

  // Prefer base token when both chains share the same base asset (1:1 value transfer).
  // For cross-base-asset syncs, force stablecoins to avoid mismatched bridge tokens.
  let bestToken: BridgeableToken | undefined;
  let bestBalance = 0n;
  let isBaseMatch = false;
  let isStableMatch = false;

  // Batch balance reads for all candidates in one multicall round-trip.
  const candidateBalances = await getVaultTokenBalancesBulk(
    srcChainId,
    params.vaultAddress,
    candidates.map((c) => c.address),
    params.alchemyKey,
  );

  for (const candidate of candidates) {
    const balance = candidateBalances.get(candidate.address.toLowerCase()) ?? 0n;

    const isBT = candidate.type === baseTokenType;
    const isStable = candidate.type === "USDC" || candidate.type === "USDT";

    if (crossBaseAsset && !isStable) continue;

    if (isBT && balance > 0n && (!isBaseMatch || balance > bestBalance)) {
      bestToken = candidate;
      bestBalance = balance;
      isBaseMatch = true;
    } else if (isStable && !isBaseMatch && balance > 0n && (!isStableMatch || balance > bestBalance)) {
      bestToken = candidate;
      bestBalance = balance;
      isStableMatch = true;
    } else if (!isBT && !isStable && !isBaseMatch && !isStableMatch && balance > bestBalance) {
      bestToken = candidate;
      bestBalance = balance;
    }
  }

  if (!bestToken || bestBalance === 0n) {
    const available = candidates.map((t) => t.symbol).join(", ");
    throw new Error(
      `No bridgeable token with balance on ${chainName(srcChainId)} for NAV equalization. ` +
      `Checked: ${available || "none bridgeable"}.`,
    );
  }

  // 6. Convert USDC bridge amount to bridge token units.
  const usdcToken = srcTokens.find((t) => t.type === "USDC");
  let bridgeAmountRaw: bigint;
  if (bestToken.type === "USDC") {
    bridgeAmountRaw = normalizeToDecimals(bridgeUsdc, 6, bestToken.decimals);
  } else {
    if (!usdcToken) {
      throw new Error(
        `Cannot convert bridge amount to ${bestToken.symbol}: no USDC token configured on ${chainName(srcChainId)}.`,
      );
    }
    bridgeAmountRaw = await convertTokenAmountViaOracle(
      srcChainId,
      usdcToken.address,
      bridgeUsdc,
      bestToken.address,
      params.alchemyKey ?? "",
    );
  }

  // 7. Apply constraints (max cap only — no minimum floor)
  // If the amount is too small for the Across solver, the API returns
  // isAmountTooLow=true and the on-chain OutputAmountTooLow revert guards it.
  let capped = false;
  let capReason: string | undefined;
  let actualBridgeUsdc = bridgeUsdc;

  if (bridgeAmountRaw > bestBalance) {
    bridgeAmountRaw = bestBalance;
    capped = true;
    capReason = `Capped at available balance (${formatUnits(bestBalance, bestToken.decimals)} ${bestToken.symbol})`;
    // Recompute the USDC value of the capped amount for simulation.
    if (bestToken.type === "USDC") {
      actualBridgeUsdc = normalizeToDecimals(bridgeAmountRaw, bestToken.decimals, 6);
    } else if (usdcToken) {
      actualBridgeUsdc = await convertTokenAmountViaOracle(
        srcChainId,
        bestToken.address,
        bridgeAmountRaw,
        usdcToken.address,
        params.alchemyKey ?? "",
      );
    }
  }

  // 8. Post-bridge NAV simulation in base-token unitaries
  const postSrcTotalUsdc = srcSnapFinal.totalUsdcNormalized - actualBridgeUsdc;
  const postDstTotalUsdc = dstSnapFinal.totalUsdcNormalized + actualBridgeUsdc;

  const postSrcPriceBase = srcSnapFinal.supplyValueUsdc > 0n
    ? Number(formatUnits(
        postSrcTotalUsdc * (10n ** BigInt(srcSnapFinal.baseTokenDecimals)) / srcSnapFinal.supplyValueUsdc,
        srcSnapFinal.baseTokenDecimals,
      ))
    : 0;
  const postDstPriceBase = dstSnapFinal.supplyValueUsdc > 0n
    ? Number(formatUnits(
        postDstTotalUsdc * (10n ** BigInt(dstSnapFinal.baseTokenDecimals)) / dstSnapFinal.supplyValueUsdc,
        dstSnapFinal.baseTokenDecimals,
      ))
    : 0;

  const preSrcDeviationBps = targetPriceBase > 0
    ? Math.round(Math.abs(srcPriceBaseFinal - targetPriceBase) / targetPriceBase * 10000)
    : 0;
  const preDstDeviationBps = targetPriceBase > 0
    ? Math.round(Math.abs(dstPriceBaseFinal - targetPriceBase) / targetPriceBase * 10000)
    : 0;
  const divergenceBps = Math.max(preSrcDeviationBps, preDstDeviationBps);

  const postSrcDeviationBps = targetPriceBase > 0
    ? Math.round(Math.abs(postSrcPriceBase - targetPriceBase) / targetPriceBase * 10000)
    : 0;
  const postDstDeviationBps = targetPriceBase > 0
    ? Math.round(Math.abs(postDstPriceBase - targetPriceBase) / targetPriceBase * 10000)
    : 0;
  const postDivergenceBps = Math.max(postSrcDeviationBps, postDstDeviationBps);

  return {
    srcChainId,
    dstChainId,
    directionAutoSwapped,
    targetPrice: nav.globalNav.targetPrice,
    srcPrice: srcPriceBaseFinal.toFixed(6),
    dstPrice: dstPriceBaseFinal.toFixed(6),
    srcBaseTokenSymbol: srcSnapFinal.baseTokenSymbol,
    dstBaseTokenSymbol: dstSnapFinal.baseTokenSymbol,
    srcEffectiveSupply: formatUnits(srcSnapFinal.effectiveSupply, srcSnapFinal.baseTokenDecimals),
    dstEffectiveSupply: formatUnits(dstSnapFinal.effectiveSupply, dstSnapFinal.baseTokenDecimals),
    srcTotalUsdc: formatUnits(srcSnapFinal.totalUsdcNormalized, 6),
    dstTotalUsdc: formatUnits(dstSnapFinal.totalUsdcNormalized, 6),
    srcDeviationUsdc: formatUnits(srcDeviationFinal, 6),
    dstDeviationUsdc: formatUnits(dstDeviationFinal, 6),
    divergenceBps,
    bridgeToken: bestToken,
    bridgeAmountFormatted: formatUnits(bridgeAmountRaw, bestToken.decimals),
    bridgeAmountRaw,
    bridgeAmountUsdc: formatUnits(actualBridgeUsdc, 6),
    postSrcPrice: postSrcPriceBase.toFixed(6),
    postDstPrice: postDstPriceBase.toFixed(6),
    postDivergenceBps,
    capped,
    capReason,
  };
}

/**
 * Build a cross-chain sync transaction (OpType.Sync).
 *
 * TWO MODES — determined by whether `amount` is provided:
 *
 * 1. Deterministic NAV equalization (amount OMITTED):
 *    Uses computeNavEqualization() to move the requested pair toward the
 *    per-base-asset group target NAV computed by getAggregatedNav(). The target
 *    is derived from aggregate USDC total assets divided by aggregate normalized
 *    effective supply within the group. Direction, token, and amount are all
 *    computed deterministically from live pool state. The optional `tokenSymbol`
 *    is treated as a preferred token when multiple bridgeable tokens are
 *    available.
 *
 * 2. Explicit amount sync (amount PROVIDED):
 *    Bridges exactly the operator-specified amount of `tokenSymbol`. The caller
 *    must provide both `amount` and `tokenSymbol`.
 *
 * The LLM must NEVER invent an amount. Either the operator supplies one, or the
 * closed-form equalization computes it.
 */
export async function buildCrosschainSync(params: {
  vaultAddress: Address;
  srcChainId: number;
  dstChainId: number;
  tokenSymbol?: string;   // required when amount is provided; preferred token when equalizing
  amount?: string;        // omit for deterministic NAV equalization
  navToleranceBps?: number;
  useNativeEth?: boolean; // true = vault wraps native ETH→WETH via sourceNativeAmount
  shouldUnwrapOnDestination?: boolean;
  alchemyKey?: string;
  /** Operator address for depositV3 simulation (extracts destination message) */
  operatorAddress?: Address;
}): Promise<{
  quote: CrosschainQuote;
  calldata: Hex;
  description: string;
  navEqualization?: NavEqualizationResult;
  navImpact?: {
    preUnitaryValue: string;
    postUnitaryValue: string;
    impactPct: string;
  };
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

  // ── Deterministic NAV equalization (amount omitted) ──
  // computeNavEqualization() handles everything:
  //   - Simulates updateUnitaryValue() on both chains for live NAV
  //   - Reads getPool() for correct per-chain decimals
  //   - Normalizes to common decimal base (handles 6 vs 18 dec differences)
  //   - Auto-corrects direction (bridges FROM higher-NAV chain)
  //   - Closed-form formula: exact bridge amount for price convergence
  //   - Post-bridge NAV simulation for verification
  // The caller must NOT invent an amount; either the operator provides it or
  // the algorithm computes it.
  if (amount === undefined) {
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
  } else if (!tokenSymbol) {
    // Explicit amount mode requires an explicit token.
    throw new Error(
      `crosschain_sync requires a token when an amount is provided. ` +
        `Either provide both token and amount, or omit amount for deterministic NAV equalization.`,
    );
  }

  // Verify balance
  const inputToken = findBridgeableToken(srcChainId, tokenSymbol);
  if (!inputToken) {
    throw new Error(`${tokenSymbol} is not bridgeable on chain ${srcChainId}.`);
  }

  // When useNativeEth is set (only valid for WETH), check native ETH balance
  // instead of WETH balance — the vault will wrap ETH→WETH automatically
  // via the sourceNativeAmount field in SourceMessageParams.
  const useNative = params.useNativeEth && inputToken.type === "WETH";

  const inputAmountRaw = parseUnits(amount, inputToken.decimals);
  if (useNative) {
    const { balance: ethBalance } = await getVaultTokenBalance(
      srcChainId,
      params.vaultAddress,
      "0x0000000000000000000000000000000000000000" as Address,
      params.alchemyKey,
    );
    if (ethBalance < inputAmountRaw) {
      const available = formatUnits(ethBalance, 18);
      throw new Error(
        `Insufficient native ETH balance in vault on ${chainName(srcChainId)} for sync. ` +
        `Available: ${available}, requested: ${amount}.`,
      );
    }
  } else {
    const { balance } = await getVaultTokenBalance(
      srcChainId,
      params.vaultAddress,
      inputToken.address,
      params.alchemyKey,
    );
    if (balance < inputAmountRaw) {
      const available = formatUnits(balance, inputToken.decimals);
      throw new Error(
        `Insufficient ${inputToken.symbol} balance on ${chainName(srcChainId)} for sync. ` +
        `Available: ${available}, needed: ${amount}.`,
      );
    }
  }

  // Get Across quote (shared with transfer — same getCrosschainQuote + fee logic)
  let quote = await getCrosschainQuote(
    srcChainId,
    dstChainId,
    tokenSymbol,
    amount,
  );

  // Determine NAV tolerance.
  // When equalization computes the bridge amount to correct a divergence, the on-chain
  // NavImpactLib checks that the source-chain NAV drop stays within navToleranceBps.
  // The default 1% (100 bps) is too tight when correcting larger divergences — the
  // bridge amount is intentionally sized to shift NAV, so the tolerance must accommodate
  // the expected impact. We use the pre-bridge divergence + 200 bps margin, capped at
  // the on-chain MAX_NAV_TOLERANCE_BPS (10000 = 100%).
  const toleranceBps = params.navToleranceBps
    ?? (navEqualization
      ? Math.min(navEqualization.divergenceBps + 200, 10000)
      : DEFAULT_NAV_TOLERANCE_BPS);

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
    sourceNativeAmount: useNative ? inputAmountRaw : undefined,
    shouldUnwrapOnDestination: params.shouldUnwrapOnDestination,
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
        sourceNativeAmount: useNative ? inputAmountRaw : undefined,
        shouldUnwrapOnDestination: params.shouldUnwrapOnDestination,
      });
    }
  }

  const srcName = chainName(srcChainId);
  const dstName = chainName(dstChainId);
  let description: string;
  if (navEqualization) {
    const eq = navEqualization;
    description = [
      `NAV sync ${srcName} → ${dstName}: ${amount} ${quote.inputToken.symbol}`,
      `Global target price: ${eq.targetPrice} per pool token`,
      `Pre-bridge price: ${srcName}=${eq.srcPrice} ${eq.srcBaseTokenSymbol}, ${dstName}=${eq.dstPrice} ${eq.dstBaseTokenSymbol}`,
      `Divergence from target: ${(eq.divergenceBps / 100).toFixed(2)}%`,
      `Post-bridge price (projected): ${srcName}=${eq.postSrcPrice} ${eq.srcBaseTokenSymbol}, ${dstName}=${eq.postDstPrice} ${eq.dstBaseTokenSymbol}`,
      `Post-divergence from target: ${(eq.postDivergenceBps / 100).toFixed(2)}%`,
      `Fee: ${quote.feePct}`,
      eq.capped ? `Note: ${eq.capReason}` : '',
      eq.directionAutoSwapped ? `Direction auto-corrected (bridging from chain above global price target)` : '',
    ].filter(Boolean).join(' | ');
  } else {
    description =
      `Sync NAV from ${srcName} → ${dstName} using ${amount} ${quote.inputToken.symbol}` +
      ` (tolerance: ${(toleranceBps / 100).toFixed(2)}%, fee: ${quote.feePct})`;
  }

  // Project source-chain NAV impact for explicit-amount syncs so the operator
  // can see why a sync might hit NavImpactTooHigh or the server-side NAV shield.
  const navImpact = !navEqualization
    ? await projectSyncNavImpact({
        vaultAddress: params.vaultAddress,
        srcChainId,
        depositV3Calldata: calldata,
        operatorAddress: params.operatorAddress,
        alchemyKey: params.alchemyKey,
      })
    : undefined;

  if (navImpact && navImpact.preUnitaryValue !== "0") {
    description += ` | Projected ${srcName} NAV impact: ${Number(navImpact.impactPct).toFixed(2)}%`;
  }

  return { quote, calldata, description, navEqualization, navImpact };
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
