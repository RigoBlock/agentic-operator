/**
 * Uniswap v4 Liquidity Management Service
 *
 * Encodes `modifyLiquidities(unlockData, deadline)` calldata for the Rigoblock
 * vault adapter. The vault routes calls to the Uniswap v4 PositionManager.
 *
 * Supports:
 *   - Mint new LP positions (add_liquidity)
 *   - Decrease/burn existing positions (remove_liquidity)
 *
 * The calldata targets the vault address (same as swaps). The vault's
 * Uniswap adapter handles PositionManager routing and token settlement.
 */

import {
  type Address,
  type Hex,
  encodeAbiParameters,
  keccak256,
  parseUnits,
  formatUnits,
  decodeFunctionResult,
  encodeFunctionData,
} from "viem";
import { encodeVaultModifyLiquidities, getTokenDecimals, getClient } from "./vault.js";
import { resolveTokenAddress } from "../config.js";
import type { Env } from "../types.js";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { ERC20_ABI } from "../abi/erc20.js";

// ── Constants ──────────────────────────────────────────────────────────

/**
 * Uniswap v4 PoolManager — per-chain deployments.
 * Source: https://docs.uniswap.org/contracts/v4/deployments
 * NOTE: PoolManager is NOT at the same address on every chain.
 */
const POOL_MANAGER: Record<number, Address> = {
  1:     "0x000000000004444c5dc75cB358380D2e3dE08A90", // Ethereum
  10:    "0x9a13f98cb987694c9f086b1f5eb990eea8264ec3", // Optimism
  56:    "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df", // BNB Chain
  130:   "0x1f98400000000000000000000000000000000004", // Unichain
  137:   "0x67366782805870060151383f4bbff9dab53e5cd6", // Polygon
  8453:  "0x498581ff718922c3f8e6a244956af099b2652b2b", // Base
  42161: "0x360e68faccca8ca495c1b759fd9eee466db9fb32", // Arbitrum
  // Testnets
  11155111: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543", // Sepolia
  84532:    "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408", // Base Sepolia
};

/** Storage slot of the `_pools` mapping in PoolManager (from StateLibrary.sol) */
const POOLS_SLOT = 6n;

/** Q96 = 2^96 for fixed-point sqrtPrice math */
const Q96 = 2n ** 96n;

/** Absolute tick bounds (for tickSpacing=1; aligned to actual spacing below) */
const MIN_TICK = -887272;
const MAX_TICK = 887272;

// ── V4 PositionManager Action Codes ───────────────────────────────────

const Actions = {
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  CLOSE_CURRENCY: 0x11,
  SETTLE_PAIR: 0x14,
  TAKE_PAIR: 0x16,
} as const;

// ── Types ──────────────────────────────────────────────────────────────

interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
}

// ── Pool State Reading ─────────────────────────────────────────────────

const EXTSLOAD_ABI = [{
  name: "extsload",
  type: "function" as const,
  stateMutability: "view" as const,
  inputs: [{ name: "slot", type: "bytes32" as const }],
  outputs: [{ name: "", type: "bytes32" as const }],
}] as const;

/**
 * Read pool slot0 from PoolManager via extsload.
 * slot0 packs: sqrtPriceX96 (160 bits) | tick (24 bits) | protocolFee (24 bits) | lpFee (24 bits)
 */
async function readPoolSlot0(
  poolId: Hex,
  chainId: number,
  alchemyApiKey: string,
): Promise<PoolState> {
  const slot = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [poolId, POOLS_SLOT],
    ),
  );

  const poolManager = POOL_MANAGER[chainId];
  if (!poolManager) throw new Error(`Uniswap v4 PoolManager not available on chain ${chainId}.`);

  const client = getClient(chainId, alchemyApiKey);
  const result = await client.readContract({
    address: poolManager,
    abi: EXTSLOAD_ABI,
    functionName: "extsload",
    args: [slot],
  });

  const raw = BigInt(result);
  const sqrtPriceX96 = raw & ((1n << 160n) - 1n);
  const tickRaw = Number((raw >> 160n) & 0xFFFFFFn);
  const tick = tickRaw >= 0x800000 ? tickRaw - 0x1000000 : tickRaw;

  if (sqrtPriceX96 === 0n) {
    throw new Error("Pool not initialized or pool ID not found on this chain.");
  }

  return { sqrtPriceX96, tick };
}

// ── Tick Math ──────────────────────────────────────────────────────────

/**
 * Convert tick to sqrtPriceX96 (Q64.96).
 * Uses floating-point approximation — sufficient for liquidity estimation.
 * On-chain math determines exact amounts; amount0Max/amount1Max guard slippage.
 */
function getSqrtRatioAtTick(tick: number): bigint {
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}

/** Align tick down to nearest multiple of tickSpacing. */
function alignTick(tick: number, tickSpacing: number): number {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

// ── Liquidity Math ─────────────────────────────────────────────────────

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

function getLiquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (amount0 * sqrtA * sqrtB) / (Q96 * (sqrtB - sqrtA));
}

function getLiquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (amount1 * Q96) / (sqrtB - sqrtA);
}

/** Compute maximum liquidity providable given both token amounts and current price. */
function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  if (sqrtPriceX96 <= sqrtRatioAX96) {
    return getLiquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0);
  }
  if (sqrtPriceX96 < sqrtRatioBX96) {
    const liq0 = getLiquidityForAmount0(sqrtPriceX96, sqrtRatioBX96, amount0);
    const liq1 = getLiquidityForAmount1(sqrtRatioAX96, sqrtPriceX96, amount1);
    return liq0 < liq1 ? liq0 : liq1;
  }
  return getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1);
}

/** Compute token amounts from liquidity and current pool price (inverse of getLiquidityForAmounts). */
function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  if (sqrtPriceX96 <= sqrtRatioAX96) {
    // All in token0
    const amount0 = (liquidity * Q96 * (sqrtRatioBX96 - sqrtRatioAX96)) / (sqrtRatioAX96 * sqrtRatioBX96);
    return { amount0, amount1: 0n };
  }
  if (sqrtPriceX96 >= sqrtRatioBX96) {
    // All in token1
    const amount1 = (liquidity * (sqrtRatioBX96 - sqrtRatioAX96)) / Q96;
    return { amount0: 0n, amount1 };
  }
  // In range — both tokens
  const amount0 = (liquidity * Q96 * (sqrtRatioBX96 - sqrtPriceX96)) / (sqrtPriceX96 * sqrtRatioBX96);
  const amount1 = (liquidity * (sqrtPriceX96 - sqrtRatioAX96)) / Q96;
  return { amount0, amount1 };
}

// ── PoolKey Helpers ────────────────────────────────────────────────────

/** Compute pool ID = keccak256(abi.encode(PoolKey)). */
function computePoolId(poolKey: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    ),
  );
}

/** Default fee → tickSpacing mapping (matches Uniswap v4 defaults). */
function defaultTickSpacing(fee: number): number {
  if (fee <= 100) return 1;
  if (fee <= 500) return 10;
  if (fee <= 3000) return 60;
  return 200;
}

// ── ABI Encoding Helpers ───────────────────────────────────────────────

const POOL_KEY_ABI = {
  type: "tuple" as const,
  components: [
    { type: "address" as const, name: "currency0" },
    { type: "address" as const, name: "currency1" },
    { type: "uint24" as const, name: "fee" },
    { type: "int24" as const, name: "tickSpacing" },
    { type: "address" as const, name: "hooks" },
  ],
};

function encodeMintParams(
  poolKey: PoolKey,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
  amount0Max: bigint,
  amount1Max: bigint,
  owner: Address,
): Hex {
  return encodeAbiParameters(
    [POOL_KEY_ABI, { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" }],
    [{ currency0: poolKey.currency0, currency1: poolKey.currency1, fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks }, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, "0x"],
  );
}

function encodeSettlePairParams(c0: Address, c1: Address): Hex {
  return encodeAbiParameters([{ type: "address" }, { type: "address" }], [c0, c1]);
}

function encodeTakePairParams(c0: Address, c1: Address, to: Address): Hex {
  return encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [c0, c1, to]);
}

function encodeDecreaseParams(tokenId: bigint, liquidity: bigint, min0: bigint, min1: bigint): Hex {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
    [tokenId, liquidity, min0, min1, "0x"],
  );
}

function encodeBurnParams(tokenId: bigint, min0: bigint, min1: bigint): Hex {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
    [tokenId, min0, min1, "0x"],
  );
}

/** Pack action codes into a single bytes value and ABI-encode (actions, params[]). */
function buildUnlockData(actions: number[], params: Hex[]): Hex {
  const actionsHex = ("0x" + actions.map((a) => a.toString(16).padStart(2, "0")).join("")) as Hex;
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actionsHex, params]);
}

// ── Tick Range Presets ─────────────────────────────────────────────────

function resolveTickRange(
  range: string,
  currentTick: number,
  tickSpacing: number,
): { tickLower: number; tickUpper: number } {
  switch (range.toLowerCase()) {
    case "full":
      return { tickLower: alignTick(MIN_TICK, tickSpacing), tickUpper: alignTick(MAX_TICK, tickSpacing) };
    case "wide": // ±50% price
      return { tickLower: alignTick(currentTick - 5000, tickSpacing), tickUpper: alignTick(currentTick + 5000, tickSpacing) };
    case "narrow": // ±5% price
      return { tickLower: alignTick(currentTick - 500, tickSpacing), tickUpper: alignTick(currentTick + 500, tickSpacing) };
    default: {
      const [lo, hi] = range.split(",").map(Number);
      if (isNaN(lo) || isNaN(hi)) throw new Error(`Invalid tick range: "${range}". Use "full", "wide", "narrow", or "tickLower,tickUpper".`);
      return { tickLower: alignTick(lo, tickSpacing), tickUpper: alignTick(hi, tickSpacing) };
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export interface AddLiquidityParams {
  tokenA: string;     // symbol or address
  tokenB: string;
  amountA: string;    // human-readable amount of tokenA
  amountB: string;    // human-readable amount of tokenB
  fee?: number;       // fee in hundredths of a bip (default 3000 = 0.30%)
  tickSpacing?: number;
  hooks?: Address;    // hook contract (default: zero address)
  tickRange?: string; // "full" | "wide" | "narrow" | "tickLower,tickUpper"
}

/**
 * Build unsigned vault tx for adding liquidity to a Uniswap v4 pool.
 *
 * Action sequence: MINT_POSITION → SETTLE_PAIR → TAKE_PAIR
 *   1. MINT_POSITION creates the position (records token debt)
 *   2. SETTLE_PAIR pays the debt from the vault's tokens
 *   3. TAKE_PAIR refunds any excess back to the vault
 */
export async function buildAddLiquidityTx(
  env: Env,
  params: AddLiquidityParams,
  chainId: number,
  vaultAddress: Address,
): Promise<{ calldata: Hex; description: string; poolId: Hex; tickLower: number; tickUpper: number }> {
  // 1. Resolve & sort token addresses (v4 requires currency0 < currency1)
  const [addrA, addrB] = await Promise.all([
    resolveTokenAddress(chainId, params.tokenA),
    resolveTokenAddress(chainId, params.tokenB),
  ]);

  const isALower = addrA.toLowerCase() < addrB.toLowerCase();
  const currency0 = (isALower ? addrA : addrB) as Address;
  const currency1 = (isALower ? addrB : addrA) as Address;
  const raw0 = isALower ? params.amountA : params.amountB;
  const raw1 = isALower ? params.amountB : params.amountA;

  // 2. Get token decimals on-chain
  const [dec0, dec1] = await Promise.all([
    getTokenDecimals(chainId, currency0, env.ALCHEMY_API_KEY),
    getTokenDecimals(chainId, currency1, env.ALCHEMY_API_KEY),
  ]);

  const amount0 = parseUnits(raw0, dec0);
  const amount1 = parseUnits(raw1, dec1);

  // 3. Build PoolKey
  const fee = params.fee ?? 3000;
  const tickSpacing = params.tickSpacing ?? defaultTickSpacing(fee);
  const hooks = params.hooks ?? ("0x0000000000000000000000000000000000000000" as Address);
  const poolKey: PoolKey = { currency0, currency1, fee, tickSpacing, hooks };
  const poolId = computePoolId(poolKey);

  // 4. Read current pool state (sqrtPriceX96, tick)
  const poolState = await readPoolSlot0(poolId, chainId, env.ALCHEMY_API_KEY);

  // 5. Resolve tick range
  const range = params.tickRange ?? "full";
  const { tickLower, tickUpper } = resolveTickRange(range, poolState.tick, tickSpacing);

  // 6. Compute liquidity from amounts + current price
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  const liquidity = getLiquidityForAmounts(poolState.sqrtPriceX96, sqrtA, sqrtB, amount0, amount1);

  if (liquidity === 0n) {
    throw new Error("Computed liquidity is zero — check that amounts and tick range are valid for the current pool price.");
  }

  // 7. Slippage: allow 1% more than requested amounts
  const amount0Max = amount0 + amount0 / 100n;
  const amount1Max = amount1 + amount1 / 100n;

  // 8. Encode: MINT_POSITION + SETTLE_PAIR + TAKE_PAIR
  const unlockData = buildUnlockData(
    [Actions.MINT_POSITION, Actions.SETTLE_PAIR, Actions.TAKE_PAIR],
    [
      encodeMintParams(poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, vaultAddress),
      encodeSettlePairParams(currency0, currency1),
      encodeTakePairParams(currency0, currency1, vaultAddress),
    ],
  );

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 min
  const calldata = encodeVaultModifyLiquidities(unlockData, deadline);

  const sym0 = isALower ? params.tokenA : params.tokenB;
  const sym1 = isALower ? params.tokenB : params.tokenA;
  const description = `[Uniswap v4] Add liquidity: ${raw0} ${sym0} + ${raw1} ${sym1} (${range} range, fee ${fee / 10000}%)`;

  return { calldata, description, poolId, tickLower, tickUpper };
}

export interface RemoveLiquidityParams {
  tokenA: string;
  tokenB: string;
  tokenId: string;           // ERC-721 position token ID
  liquidityAmount: string;   // amount of liquidity units to remove
  burn?: boolean;            // burn the NFT after full removal (default: true)
}

/**
 * Build unsigned vault tx for removing liquidity from a Uniswap v4 position.
 *
 * Action sequence: DECREASE_LIQUIDITY → TAKE_PAIR [→ BURN_POSITION]
 */
export async function buildRemoveLiquidityTx(
  env: Env,
  params: RemoveLiquidityParams,
  chainId: number,
  vaultAddress: Address,
): Promise<{ calldata: Hex; description: string }> {
  const [addrA, addrB] = await Promise.all([
    resolveTokenAddress(chainId, params.tokenA),
    resolveTokenAddress(chainId, params.tokenB),
  ]);

  const isALower = addrA.toLowerCase() < addrB.toLowerCase();
  const currency0 = (isALower ? addrA : addrB) as Address;
  const currency1 = (isALower ? addrB : addrA) as Address;

  const tokenId = BigInt(params.tokenId);
  const liquidity = BigInt(params.liquidityAmount);
  const shouldBurn = params.burn !== false;

  const actions: number[] = [Actions.DECREASE_LIQUIDITY, Actions.TAKE_PAIR];
  const actionParams: Hex[] = [
    encodeDecreaseParams(tokenId, liquidity, 0n, 0n),
    encodeTakePairParams(currency0, currency1, vaultAddress),
  ];

  if (shouldBurn) {
    actions.push(Actions.BURN_POSITION);
    actionParams.push(encodeBurnParams(tokenId, 0n, 0n));
  }

  const unlockData = buildUnlockData(actions, actionParams);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const calldata = encodeVaultModifyLiquidities(unlockData, deadline);

  const description = `[Uniswap v4] Remove liquidity from position #${tokenId} (${params.tokenA}/${params.tokenB})${shouldBurn ? " + burn NFT" : ""}`;
  return { calldata, description };
}

// ── Uniswap v4 PositionManager (POSM) — per-chain deployments ────────
// Source: https://docs.uniswap.org/contracts/v4/deployments
// NOTE: Unlike PoolManager, POSM is NOT CREATE2-deterministic. Each chain has
// its own deployment address.

const POSITION_MANAGER: Record<number, Address> = {
  1:     "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e", // Ethereum
  10:    "0x3c3ea4b57a46241e54610e5f022e5c45859a1017", // Optimism
  56:    "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b", // BNB Chain
  130:   "0x4529a01c7a0410167c5740c487a8de60232617bf", // Unichain
  137:   "0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9", // Polygon
  8453:  "0x7c5f5a4bbd8fd63184577525326123b519429bdc", // Base
  42161: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869", // Arbitrum
  // Testnets
  11155111: "0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4", // Sepolia
  84532:    "0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80", // Base Sepolia
};

const POSITION_MANAGER_ABI = [
  // getPoolAndPositionInfo(uint256 tokenId) → (PoolKey, PositionInfo)
  // PositionInfo is `type PositionInfo is uint256` (packed):
  //   bits [255..56] poolId (bytes25) | [55..32] tickUpper (int24) | [31..8] tickLower (int24) | [7..0] hasSubscriber
  {
    name: "getPoolAndPositionInfo",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "tokenId", type: "uint256" as const }],
    outputs: [
      {
        name: "poolKey", type: "tuple" as const,
        components: [
          { name: "currency0", type: "address" as const },
          { name: "currency1", type: "address" as const },
          { name: "fee", type: "uint24" as const },
          { name: "tickSpacing", type: "int24" as const },
          { name: "hooks", type: "address" as const },
        ],
      },
      { name: "info", type: "uint256" as const },
    ],
  },
  // getPositionLiquidity(uint256 tokenId) → uint128 liquidity
  {
    name: "getPositionLiquidity",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "tokenId", type: "uint256" as const }],
    outputs: [{ name: "liquidity", type: "uint128" as const }],
  },
] as const;

// ── LP Position Reading ────────────────────────────────────────────────

export interface LPPosition {
  tokenId: string;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  symbol0: string;
  symbol1: string;
  amount0: string;    // human-readable formatted amount
  amount1: string;    // human-readable formatted amount
  decimals0: number;
  decimals1: number;
}

/**
 * Decode packed PositionInfo (uint256) from the Uniswap v4 PositionManager.
 *
 * Layout (from PositionInfoLibrary.sol, LSB first):
 *   bits [7..0]     = hasSubscriber  (uint8)
 *   bits [31..8]    = tickLower      (int24, signed)
 *   bits [55..32]   = tickUpper      (int24, signed)
 *   bits [255..56]  = poolId         (bytes25)
 *
 * Extraction mirrors the Solidity assembly:
 *   tickLower = signextend(2, shr(8, info))
 *   tickUpper = signextend(2, shr(32, info))
 */
export function decodePositionInfo(packed: bigint): { tickLower: number; tickUpper: number } {
  const rawLower = Number((packed >> 8n) & 0xFFFFFFn);
  const rawUpper = Number((packed >> 32n) & 0xFFFFFFn);
  return {
    tickLower: rawLower >= 0x800000 ? rawLower - 0x1000000 : rawLower,
    tickUpper: rawUpper >= 0x800000 ? rawUpper - 0x1000000 : rawUpper,
  };
}

/**
 * Get all Uniswap v4 LP positions held by a vault, enriched with token
 * symbols, decimals, and computed token amounts.
 *
 * 1. Calls vault.getUniV4TokenIds() to get active position NFT IDs
 * 2. Multicalls PositionManager for pool info + liquidity
 * 3. Batch-reads pool sqrtPriceX96 + ERC20 symbol/decimals for all tokens
 * 4. Computes token amounts from liquidity + price + tick range
 */
export async function getVaultLPPositions(
  chainId: number,
  vaultAddress: Address,
  alchemyApiKey: string,
): Promise<LPPosition[]> {
  const posm = POSITION_MANAGER[chainId];
  if (!posm) throw new Error(`Uniswap v4 PositionManager not available on chain ${chainId}. Supported chains: ${Object.keys(POSITION_MANAGER).join(", ")}.`);
  const poolManager = POOL_MANAGER[chainId];
  if (!poolManager) throw new Error(`Uniswap v4 PoolManager not available on chain ${chainId}.`);

  const client = getClient(chainId, alchemyApiKey);

  // 1. Get token IDs from the vault's EApps extension
  let tokenIds: readonly bigint[];
  try {
    tokenIds = await client.readContract({
      address: vaultAddress,
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "getUniV4TokenIds",
    }) as readonly bigint[];
  } catch (err) {
    throw new Error(`Failed to read Uniswap v4 token IDs from vault ${vaultAddress}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (tokenIds.length === 0) return [];

  // 2. Multicall POSM: getPoolAndPositionInfo + getPositionLiquidity per token
  const posmCalls = tokenIds.flatMap((tokenId) => [
    {
      address: posm,
      abi: POSITION_MANAGER_ABI,
      functionName: "getPoolAndPositionInfo" as const,
      args: [tokenId] as const,
    },
    {
      address: posm,
      abi: POSITION_MANAGER_ABI,
      functionName: "getPositionLiquidity" as const,
      args: [tokenId] as const,
    },
  ]);

  const posmResults = await client.multicall({ contracts: posmCalls });

  // 3. Parse basic position data
  interface RawPosition {
    tokenId: bigint;
    poolKey: PoolKey;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
    poolId: Hex;
  }

  const rawPositions: RawPosition[] = [];
  const uniqueTokens = new Set<string>(); // lowercase addresses of non-ETH tokens
  const uniquePoolIds = new Map<string, { poolKey: PoolKey; poolId: Hex }>(); // poolId → data

  for (let i = 0; i < tokenIds.length; i++) {
    const infoResult = posmResults[i * 2];
    const liqResult = posmResults[i * 2 + 1];
    if (infoResult.status !== "success" || !infoResult.result) continue;
    if (liqResult.status !== "success") continue;

    const [poolKey, packedInfo] = infoResult.result as [
      { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address },
      bigint,
    ];
    const liquidity = liqResult.result as bigint;
    const { tickLower, tickUpper } = decodePositionInfo(packedInfo);
    const poolId = computePoolId(poolKey);

    rawPositions.push({ tokenId: tokenIds[i], poolKey, tickLower, tickUpper, liquidity, poolId });

    // Track unique tokens and pools for batch reads
    if (poolKey.currency0.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
      uniqueTokens.add(poolKey.currency0.toLowerCase());
    }
    if (poolKey.currency1.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
      uniqueTokens.add(poolKey.currency1.toLowerCase());
    }
    if (!uniquePoolIds.has(poolId)) {
      uniquePoolIds.set(poolId, { poolKey, poolId });
    }
  }

  if (rawPositions.length === 0) return [];

  // 4. Build batch calls: pool prices (extsload) + token symbol/decimals
  const tokenList = [...uniqueTokens];
  const poolList = [...uniquePoolIds.values()];

  // Pool price slots
  const poolSlots = poolList.map(({ poolId }) =>
    keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, POOLS_SLOT])),
  );

  const enrichCalls = [
    // Pool sqrtPriceX96 via extsload
    ...poolSlots.map((slot) => ({
      address: poolManager,
      abi: EXTSLOAD_ABI,
      functionName: "extsload" as const,
      args: [slot] as const,
    })),
    // Token symbols
    ...tokenList.map((addr) => ({
      address: addr as Address,
      abi: ERC20_ABI,
      functionName: "symbol" as const,
      args: [] as const,
    })),
    // Token decimals
    ...tokenList.map((addr) => ({
      address: addr as Address,
      abi: ERC20_ABI,
      functionName: "decimals" as const,
      args: [] as const,
    })),
  ];

  const enrichResults = await client.multicall({ contracts: enrichCalls });

  // 5. Parse enrichment results
  const poolPrices = new Map<string, bigint>(); // poolId → sqrtPriceX96
  for (let i = 0; i < poolList.length; i++) {
    const result = enrichResults[i];
    if (result.status === "success" && result.result) {
      const raw = BigInt(result.result as string);
      const sqrtPriceX96 = raw & ((1n << 160n) - 1n);
      poolPrices.set(poolList[i].poolId, sqrtPriceX96);
    }
  }

  const symbolOffset = poolList.length;
  const decimalsOffset = poolList.length + tokenList.length;
  const tokenSymbols = new Map<string, string>();
  const tokenDecimals = new Map<string, number>();

  for (let i = 0; i < tokenList.length; i++) {
    const symResult = enrichResults[symbolOffset + i];
    if (symResult.status === "success" && symResult.result) {
      tokenSymbols.set(tokenList[i], symResult.result as string);
    }
    const decResult = enrichResults[decimalsOffset + i];
    if (decResult.status === "success" && decResult.result != null) {
      tokenDecimals.set(tokenList[i], Number(decResult.result));
    }
  }

  // Chain-aware native token symbol
  const nativeSymbol: Record<number, string> = { 56: "BNB", 137: "POL" };
  const nativeSym = nativeSymbol[chainId] || "ETH";

  const getSymbol = (addr: Address): string => {
    if (addr.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return nativeSym;
    return tokenSymbols.get(addr.toLowerCase()) || `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  };
  const getDec = (addr: Address): number => {
    if (addr.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return 18;
    return tokenDecimals.get(addr.toLowerCase()) ?? 18;
  };

  // 6. Compute token amounts and build final positions
  const positions: LPPosition[] = [];
  for (const rp of rawPositions) {
    const dec0 = getDec(rp.poolKey.currency0);
    const dec1 = getDec(rp.poolKey.currency1);
    const sym0 = getSymbol(rp.poolKey.currency0);
    const sym1 = getSymbol(rp.poolKey.currency1);

    let amount0Str = "0";
    let amount1Str = "0";

    const sqrtPrice = poolPrices.get(rp.poolId);
    if (sqrtPrice && sqrtPrice > 0n && rp.liquidity > 0n) {
      const sqrtA = getSqrtRatioAtTick(rp.tickLower);
      const sqrtB = getSqrtRatioAtTick(rp.tickUpper);
      const { amount0, amount1 } = getAmountsForLiquidity(sqrtPrice, sqrtA, sqrtB, rp.liquidity);
      amount0Str = formatUnits(amount0, dec0);
      amount1Str = formatUnits(amount1, dec1);
    }

    positions.push({
      tokenId: rp.tokenId.toString(),
      currency0: rp.poolKey.currency0,
      currency1: rp.poolKey.currency1,
      fee: rp.poolKey.fee,
      tickSpacing: rp.poolKey.tickSpacing,
      hooks: rp.poolKey.hooks,
      tickLower: rp.tickLower,
      tickUpper: rp.tickUpper,
      liquidity: rp.liquidity.toString(),
      symbol0: sym0,
      symbol1: sym1,
      amount0: amount0Str,
      amount1: amount1Str,
      decimals0: dec0,
      decimals1: dec1,
    });
  }

  return positions;
}

// ── Fee Collection ─────────────────────────────────────────────────────

/**
 * Build unsigned vault tx to collect accrued fees from a Uniswap v4 LP position.
 *
 * Action sequence: DECREASE_LIQUIDITY(0) → TAKE_PAIR
 *   - DECREASE_LIQUIDITY with amount=0 triggers fee collection without removing liquidity
 *   - TAKE_PAIR sends the collected fees back to the vault
 */
export function buildCollectFeesTx(
  tokenId: string,
  currency0: Address,
  currency1: Address,
  vaultAddress: Address,
): { calldata: Hex; description: string } {
  const tokenIdBn = BigInt(tokenId);

  // DECREASE_LIQUIDITY with 0 liquidity = collect fees only
  const unlockData = buildUnlockData(
    [Actions.DECREASE_LIQUIDITY, Actions.TAKE_PAIR],
    [
      encodeDecreaseParams(tokenIdBn, 0n, 0n, 0n),
      encodeTakePairParams(currency0, currency1, vaultAddress),
    ],
  );

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const calldata = encodeVaultModifyLiquidities(unlockData, deadline);

  const description = `[Uniswap v4] Collect fees from position #${tokenId}`;
  return { calldata, description };
}
