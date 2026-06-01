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
import { getClient } from "./vault.js";
import { resolveTokenAddress } from "../config.js";
import { TickMath } from "@uniswap/v3-sdk";
import JSBI from "jsbi";
import { BACKGEO_ORACLE } from "./oraclePool.js";

// ── Constants ──────────────────────────────────────────────────────────

const ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const Q96 = 2n ** 96n;
const MAX_TICK_SPACING = 32767;
const ORACLE_POOL_FEE = 0;

/** Wrapped native token addresses per chain — mapped to address(0) for oracle math */
const WRAPPED_NATIVE_ADDRESSES: Record<number, string> = {
  1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",     // Ethereum
  10: "0x4200000000000000000000000000000000000006",      // Optimism
  56: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",     // BNB (WBNB)
  130: "0x4200000000000000000000000000000000000006",     // Unichain
  137: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",   // Polygon (WMATIC)
  8453: "0x4200000000000000000000000000000000000006",    // Base
  42161: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",  // Arbitrum
};

// ── ABI ────────────────────────────────────────────────────────────────

/** Minimal ABI for the BackgeoOracle hook — observe() and getState() */
const ORACLE_ABI = [
  {
    name: "observe",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [
      {
        name: "key",
        type: "tuple" as const,
        components: [
          { name: "currency0", type: "address" as const },
          { name: "currency1", type: "address" as const },
          { name: "fee", type: "uint24" as const },
          { name: "tickSpacing", type: "int24" as const },
          { name: "hooks", type: "address" as const },
        ],
      },
      { name: "secondsAgos", type: "uint32[]" as const },
    ],
    outputs: [
      { name: "tickCumulatives", type: "int48[]" as const },
      { name: "secondsPerLiquidityCumulativeX128s", type: "uint144[]" as const },
    ],
  },
  {
    name: "getState",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [
      {
        name: "key",
        type: "tuple" as const,
        components: [
          { name: "currency0", type: "address" as const },
          { name: "currency1", type: "address" as const },
          { name: "fee", type: "uint24" as const },
          { name: "tickSpacing", type: "int24" as const },
          { name: "hooks", type: "address" as const },
        ],
      },
    ],
    outputs: [
      {
        name: "state",
        type: "tuple" as const,
        components: [
          { name: "index", type: "uint16" as const },
          { name: "cardinality", type: "uint16" as const },
          { name: "cardinalityNext", type: "uint16" as const },
        ],
      },
    ],
  },
] as const;

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
  const wrapped = WRAPPED_NATIVE_ADDRESSES[chainId];
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

  const poolKey = buildOraclePoolKey(chainId, normalizedToken);
  const client = getClient(chainId, alchemyKey);

  const result = (await client.readContract({
    address: oracle,
    abi: ORACLE_ABI,
    functionName: "observe",
    args: [poolKey, [0, 1]],
  })) as [bigint[], bigint[]];

  const tickCumulatives = result[0];
  // tick = (cumulative_at_now - cumulative_at_1s_ago) / 1_second
  const tick = Number(tickCumulatives[0] - tickCumulatives[1]);
  return tick;
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
      abi: ORACLE_ABI,
      functionName: "getState",
      args: [poolKey],
    })) as { index: number; cardinality: number; cardinalityNext: number };

    return state.cardinality > 0;
  } catch {
    return false;
  }
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

  // Fetch spot ticks (0 for ETH by definition)
  const [tokenTick, targetTick] = await Promise.all([
    normalizedToken === ETH_ADDRESS ? Promise.resolve(0) : getOracleSpotTick(chainId, normalizedToken, alchemyKey),
    normalizedTarget === ETH_ADDRESS ? Promise.resolve(0) : getOracleSpotTick(chainId, normalizedTarget, alchemyKey),
  ]);

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
 */
export async function hasPriceFeedForPair(
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  alchemyKey: string,
): Promise<boolean> {
  const [inFeed, outFeed] = await Promise.all([
    hasOraclePriceFeed(chainId, tokenIn, alchemyKey),
    hasOraclePriceFeed(chainId, tokenOut, alchemyKey),
  ]);
  return inFeed && outFeed;
}
