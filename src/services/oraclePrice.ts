/**
 * Direct BackgeoOracle Price Service
 *
 * Queries the BackgeoOracle V4 hook directly for spot prices (not TWAP),
 * replicating the EOracle._convertTokenAmount logic offchain.
 *
 * Using spot price instead of 5-minute TWAP because:
 * - The swap shield runs offchain before broadcast
 * - Nobody but the caller knows the swap is coming, so same-block manipulation is impossible
 * - TWAP lags during volatile moves, causing false-positive blocks
 *
 * Spot tick is extracted via observe(secondsAgos=[0, 1]):
 *   tick = tickCumulative[0] - tickCumulative[1]
 * This works because observe(0) returns the current cumulative at block time,
 * and observe(1) interpolates to 1 second ago using the current tick.
 */

import { type Address, type Hex, keccak256, encodeAbiParameters } from "viem";
import { getClient } from "./rpcClient.js";
import { getWrappedNativeAddress } from "../config.js";
import { BACKGEO_ORACLE_ABI } from "./oracleAbi.js";
import { TickMath } from "@uniswap/v3-sdk";
import JSBI from "jsbi";
import { BACKGEO_ORACLE } from "./oraclePool.js";

// ── Constants ──────────────────────────────────────────────────────────

const ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const Q96 = 2n ** 96n;
const MAX_TICK_SPACING = 32767;
const ORACLE_POOL_FEE = 0;

/** TTL for the in-memory oracle spot-tick cache (ms). Keep this short so the
 *  spot price updates with new blocks/transactions, but long enough to collapse
 *  genuinely redundant RPC calls fired in the same burst (e.g., Alchemy invoking
 *  the gas-policy webhook multiple times for one UserOp). */
const TICK_CACHE_TTL_MS = 1_000;

interface TickCacheEntry {
  tick: number;
  expiresAt: number;
}

const tickCache = new Map<string, TickCacheEntry>();

function getTickCacheKey(chainId: number, token: Address, oracle: Address): string {
  return `${chainId}:${token.toLowerCase()}:${oracle.toLowerCase()}`;
}

/** Clear the in-memory oracle tick cache. Exported for tests only. */
export function clearOracleTickCache(): void {
  tickCache.clear();
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Convert JSBI (from @uniswap/v3-sdk) to native bigint */
function jsbiToBigInt(x: JSBI): bigint {
  return BigInt(x.toString());
}

/** Get sqrtPriceX96 at a given tick using Uniswap TickMath */
function getSqrtPriceAtTick(tick: number): bigint {
  const jsbiResult = TickMath.getSqrtRatioAtTick(tick);
  return jsbiToBigInt(jsbiResult);
}

/** Normalize a token address to the form the oracle expects:
 *  - ETH zero address stays zero address
 *  - WETH / wrapped native → zero address
 *  - 0xeeee... → zero address
 */
export function normalizeTokenAddress(token: Address, chainId: number): Address {
  const lower = token.toLowerCase();
  if (lower === ETH_ADDRESS.toLowerCase()) return ETH_ADDRESS;
  if (lower === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") return ETH_ADDRESS;
  const wrapped = getWrappedNativeAddress(chainId);
  if (wrapped && lower === wrapped.toLowerCase()) return ETH_ADDRESS;
  return token;
}

/** Build the fixed BackgeoOracle pool key for a token against ETH */
function buildOraclePoolKey(
  chainId: number,
  tokenAddr: Address,
): { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } {
  return {
    currency0: ETH_ADDRESS,
    currency1: tokenAddr,
    fee: ORACLE_POOL_FEE,
    tickSpacing: MAX_TICK_SPACING,
    hooks: BACKGEO_ORACLE[chainId],
  };
}

/** Compute the PoolId from a PoolKey (keccak256 of ABI-encoded key) */
function getPoolId(poolKey: ReturnType<typeof buildOraclePoolKey>): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    ),
  );
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Get the current spot tick for a token's oracle pool.
 *
 * Uses secondsAgos = [0, 1]. The difference of tick cumulatives over 1 second
 * equals the instantaneous tick (mathematically verified in Oracle.sol).
 */
export async function getOracleSpotTick(
  chainId: number,
  token: Address,
  alchemyKey: string,
): Promise<number> {
  const oracle = BACKGEO_ORACLE[chainId];
  if (!oracle) {
    throw new Error(`BackgeoOracle not deployed on chain ${chainId}`);
  }

  const normalizedToken = normalizeTokenAddress(token, chainId);
  if (normalizedToken === ETH_ADDRESS) {
    return 0; // ETH price is 1 by definition
  }

  // Check in-memory cache to avoid redundant observe() RPC calls for the same
  // pool within a short window. This is especially important when Alchemy's
  // Gas Manager invokes the gas-policy webhook multiple times for one UserOp.
  const cacheKey = getTickCacheKey(chainId, normalizedToken, oracle);
  const cached = tickCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tick;
  }

  const poolKey = buildOraclePoolKey(chainId, normalizedToken);
  const client = getClient(chainId, alchemyKey);

  const SECONDS_AGOS = [0, 1] as const;
  const result = (await client.readContract({
    address: oracle,
    abi: BACKGEO_ORACLE_ABI,
    functionName: "observe",
    args: [poolKey, SECONDS_AGOS],
  })) as unknown as [bigint[], bigint[]];

  const tick = observeResultToTick(result, SECONDS_AGOS);

  tickCache.set(cacheKey, { tick, expiresAt: Date.now() + TICK_CACHE_TTL_MS });
  return tick;
}

/** Convert an observe() return tuple to an instantaneous tick. */
function observeResultToTick(
  result: [bigint[], bigint[]],
  secondsAgos: readonly number[],
): number {
  const tickCumulatives = result[0];
  const deltaSeconds = secondsAgos[1] - secondsAgos[0];
  // tick = delta_cumulative / delta_seconds — must divide explicitly so the
  // formula stays correct if the observation window is ever widened.
  return Number(tickCumulatives[0] - tickCumulatives[1]) / deltaSeconds;
}

/**
 * Check whether the BackgeoOracle has an active price feed for a token.
 * A feed is active if the oracle pool has cardinality > 0 (at least one observation).
 */
export async function hasOraclePriceFeed(
  chainId: number,
  token: Address,
  alchemyKey: string,
): Promise<boolean> {
  const oracle = BACKGEO_ORACLE[chainId];
  if (!oracle) return false;

  const normalizedToken = normalizeTokenAddress(token, chainId);
  if (normalizedToken === ETH_ADDRESS) return true;

  const poolKey = buildOraclePoolKey(chainId, normalizedToken);
  const client = getClient(chainId, alchemyKey);

  try {
    const state = (await client.readContract({
      address: oracle,
      abi: BACKGEO_ORACLE_ABI,
      functionName: "getState",
      args: [poolKey],
    })) as { index: number; cardinality: number; cardinalityNext: number };

    return state.cardinality > 0;
  } catch {
    return false;
  }
}

/**
 * Fetch spot ticks for a token pair in the fewest RPC round-trips possible.
 *
 * - If both tokens are ETH-normalized, returns [0, 0] with no RPC.
 * - If one token is ETH, returns the non-ETH tick via a single observe() call
 *   (or the in-memory cache).
 * - If both tokens are non-ETH, batches both observe() calls into one viem
 *   multicall RPC round-trip and caches both results.
 */
async function getSpotTicksForPair(
  chainId: number,
  tokenA: Address,
  tokenB: Address,
  alchemyKey: string,
): Promise<[number, number]> {
  const oracle = BACKGEO_ORACLE[chainId];
  if (!oracle) {
    throw new Error(`BackgeoOracle not deployed on chain ${chainId}`);
  }

  const isAEth = tokenA === ETH_ADDRESS;
  const isBEth = tokenB === ETH_ADDRESS;

  if (isAEth && isBEth) return [0, 0];

  // Single non-ETH token: reuse the cached getOracleSpotTick path.
  if (isAEth) {
    return [0, await getOracleSpotTick(chainId, tokenB, alchemyKey)];
  }
  if (isBEth) {
    return [await getOracleSpotTick(chainId, tokenA, alchemyKey), 0];
  }

  // Both non-ETH: batch the two observe() calls via viem multicall.
  const client = getClient(chainId, alchemyKey);
  const SECONDS_AGOS = [0, 1] as const;
  const poolKeyA = buildOraclePoolKey(chainId, tokenA);
  const poolKeyB = buildOraclePoolKey(chainId, tokenB);

  const results = (await client.multicall({
    contracts: [
      {
        address: oracle,
        abi: BACKGEO_ORACLE_ABI,
        functionName: "observe",
        args: [poolKeyA, SECONDS_AGOS],
      },
      {
        address: oracle,
        abi: BACKGEO_ORACLE_ABI,
        functionName: "observe",
        args: [poolKeyB, SECONDS_AGOS],
      },
    ],
  })) as unknown as [bigint[], bigint[]][];

  const tickA = observeResultToTick(results[0], SECONDS_AGOS);
  const tickB = observeResultToTick(results[1], SECONDS_AGOS);

  tickCache.set(getTickCacheKey(chainId, tokenA, oracle), { tick: tickA, expiresAt: Date.now() + TICK_CACHE_TTL_MS });
  tickCache.set(getTickCacheKey(chainId, tokenB, oracle), { tick: tickB, expiresAt: Date.now() + TICK_CACHE_TTL_MS });

  return [tickA, tickB];
}

/**
 * Convert a token amount to targetToken using the oracle spot price.
 *
 * Replicates EOracle._convertTokenAmount logic offchain:
 * 1. Get spot ticks for both tokens (0 for ETH)
 * 2. Compute conversion tick based on direction
 * 3. Convert tick → sqrtPriceX96 → priceX192
 * 4. amountOut = (amountIn * priceX192) / (Q96 * Q96)
 */
export async function convertTokenAmountViaOracle(
  chainId: number,
  token: Address,
  amount: bigint,
  targetToken: Address,
  alchemyKey: string,
): Promise<bigint> {
  if (amount === 0n) return 0n;

  const normalizedToken = normalizeTokenAddress(token, chainId);
  const normalizedTarget = normalizeTokenAddress(targetToken, chainId);

  if (normalizedToken === normalizedTarget) return amount;

  // Fetch spot ticks (0 for ETH by definition). When both tokens are non-ETH,
  // batch the two observe() calls into a single viem multicall RPC round-trip.
  const [tokenTick, targetTick] = await getSpotTicksForPair(
    chainId,
    normalizedToken,
    normalizedTarget,
    alchemyKey,
  );

  // Compute conversion tick exactly as EOracle does:
  // ETH → token:   tick = targetTick
  // token → ETH:   tick = -tokenTick
  // tokenA → tokenB: tick = targetTick - tokenTick
  let conversionTick: number;
  if (normalizedToken === ETH_ADDRESS) {
    conversionTick = targetTick;
  } else if (normalizedTarget === ETH_ADDRESS) {
    conversionTick = -tokenTick;
  } else {
    conversionTick = targetTick - tokenTick;
  }

  // TickMath.MIN_TICK = -887272, TickMath.MAX_TICK = 887272
  if (conversionTick < -887272 || conversionTick > 887272) {
    throw new Error(
      `Oracle conversion tick out of bounds (${conversionTick}) for ${token} → ${targetToken} on chain ${chainId}`
    );
  }

  const sqrtPriceX96 = getSqrtPriceAtTick(conversionTick);
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  const absAmount = amount < 0n ? -amount : amount;
  const converted = (absAmount * priceX192) / (Q96 * Q96);

  return amount < 0n ? -converted : converted;
}

/**
 * Convenience: check if both tokens in a pair have active oracle feeds.
 *
 * Batches the two getState() calls into a single viem multicall RPC round-trip
 * when both tokens are non-ETH.
 */
export async function hasPriceFeedForPair(
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  alchemyKey: string,
): Promise<boolean> {
  const oracle = BACKGEO_ORACLE[chainId];
  if (!oracle) return false;

  const normalizedIn = normalizeTokenAddress(tokenIn, chainId);
  const normalizedOut = normalizeTokenAddress(tokenOut, chainId);

  const inIsEth = normalizedIn === ETH_ADDRESS;
  const outIsEth = normalizedOut === ETH_ADDRESS;

  if (inIsEth && outIsEth) return true;
  if (inIsEth) return hasOraclePriceFeed(chainId, tokenOut, alchemyKey);
  if (outIsEth) return hasOraclePriceFeed(chainId, tokenIn, alchemyKey);

  // Both non-ETH: batch the two getState() calls.
  const client = getClient(chainId, alchemyKey);
  const results = await client.multicall({
    allowFailure: true,
    contracts: [
      {
        address: oracle,
        abi: BACKGEO_ORACLE_ABI,
        functionName: "getState",
        args: [buildOraclePoolKey(chainId, normalizedIn)],
      },
      {
        address: oracle,
        abi: BACKGEO_ORACLE_ABI,
        functionName: "getState",
        args: [buildOraclePoolKey(chainId, normalizedOut)],
      },
    ],
  });

  const inResult = results[0];
  const outResult = results[1];
  const inCardinality = inResult.status === "success"
    ? (inResult.result as { cardinality: number }).cardinality
    : 0;
  const outCardinality = outResult.status === "success"
    ? (outResult.result as { cardinality: number }).cardinality
    : 0;

  return inCardinality > 0 && outCardinality > 0;
}
