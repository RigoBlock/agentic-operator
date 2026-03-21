/**
 * Uniswap v4 Liquidity Management Service
 *
 * Uses the official @uniswap/v4-sdk to encode LP calldata, then wraps it
 * for the Rigoblock vault adapter. The vault routes calls to the Uniswap v4
 * PositionManager.
 *
 * Flow:
 *   1. Read pool state from chain (sqrtPriceX96, tick, liquidity via StateView)
 *   2. Build SDK Pool + Position objects (handles liquidity math + tick alignment)
 *   3. V4PositionManager.addCallParameters() encodes modifyLiquidities calldata
 *   4. SDK output targets PositionManager — since the vault adapter uses the same
 *      function signature, the calldata is byte-for-byte identical. We just send
 *      it to the vault address instead.
 *
 * Supports:
 *   - Mint new LP positions (add_liquidity)
 *   - Decrease/burn existing positions (remove_liquidity)
 *   - Collect fees from existing positions
 */

import {
  type Address,
  type Hex,
  encodeAbiParameters,
  keccak256,
  parseUnits,
  formatUnits,
} from "viem";
import { Pool, Position, V4PositionManager } from "@uniswap/v4-sdk";
import { Token, Ether, Percent, type Currency } from "@uniswap/sdk-core";
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

/**
 * Uniswap v4 StateView — per-chain deployments.
 * Source: https://docs.uniswap.org/contracts/v4/deployments
 * Provides getSlot0() and getLiquidity() — no raw storage assumptions.
 */
const STATE_VIEW: Record<number, Address> = {
  1:     "0x7ffe42c4a5deea5b0fec41c94c136cf115597227", // Ethereum
  10:    "0xc18a3169788f4f75a170290584eca6395c75ecdb", // Optimism
  56:    "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4", // BNB Chain
  130:   "0x86e8631a016f9068c3f085faf484ee3f5fdee8f2", // Unichain
  137:   "0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a", // Polygon
  8453:  "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71", // Base
  42161: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990", // Arbitrum
};

/** Q96 = 2^96 for fixed-point sqrtPrice math */
const Q96 = 2n ** 96n;

/** Absolute tick bounds (for tickSpacing=1; aligned to actual spacing below) */
const MIN_TICK = -887272;
const MAX_TICK = 887272;

// ── V4 PositionManager Action Codes (for manual encoding — fee collection, remove) ──

const Actions = {
  DECREASE_LIQUIDITY: 0x01,
  BURN_POSITION: 0x03,
  TAKE_PAIR: 0x11,
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
  liquidity: bigint;
}

// ── Pool State Reading (via StateView contract) ───────────────────────

const STATEVIEW_ABI = [
  {
    name: "getSlot0",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "poolId", type: "bytes32" as const }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" as const },
      { name: "tick", type: "int24" as const },
      { name: "protocolFee", type: "uint24" as const },
      { name: "lpFee", type: "uint24" as const },
    ],
  },
  {
    name: "getLiquidity",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "poolId", type: "bytes32" as const }],
    outputs: [{ name: "liquidity", type: "uint128" as const }],
  },
] as const;

/**
 * Read pool state (sqrtPriceX96, tick, liquidity) via the Uniswap v4 StateView contract.
 * Uses getSlot0() and getLiquidity() — no raw storage slot assumptions.
 */
async function readPoolState(
  poolId: Hex,
  chainId: number,
  alchemyApiKey: string,
): Promise<PoolState> {
  const stateView = STATE_VIEW[chainId];
  if (!stateView) throw new Error(`Uniswap v4 StateView not available on chain ${chainId}.`);

  const client = getClient(chainId, alchemyApiKey);

  const [slot0Result, liqResult] = await Promise.all([
    client.readContract({
      address: stateView,
      abi: STATEVIEW_ABI,
      functionName: "getSlot0",
      args: [poolId],
    }),
    client.readContract({
      address: stateView,
      abi: STATEVIEW_ABI,
      functionName: "getLiquidity",
      args: [poolId],
    }),
  ]);

  const sqrtPriceX96 = slot0Result[0];
  const tick = slot0Result[1];
  const liquidity = liqResult;

  if (sqrtPriceX96 === 0n) {
    throw new Error("Pool not initialized or pool ID not found on this chain.");
  }
  return { sqrtPriceX96, tick, liquidity };
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

// ── Liquidity Math (for position reading only — SDK handles add/remove) ──

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** Map an on-chain address to an SDK Currency object (Ether for native, Token otherwise). */
function toCurrency(chainId: number, address: Address, decimals: number): Currency {
  return address.toLowerCase() === ZERO_ADDRESS.toLowerCase()
    ? Ether.onChain(chainId)
    : new Token(chainId, address, decimals);
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

/**
 * Default fee → tickSpacing mapping for the standard Uniswap v4 tiers.
 * Uniswap v4 permits any uint24 fee and any int24 tickSpacing — custom pools
 * may use values not covered here.  When in doubt, call getPoolInfoById() to
 * read the exact tickSpacing from the pool's Initialize event.
 */
function defaultTickSpacing(fee: number): number {
  if (fee <= 100)  return 1;
  if (fee <= 500)  return 10;
  if (fee <= 3000) return 60;
  if (fee <= 6000) return 120;  // 0.6% tier (e.g. XAUT/USDT on Arbitrum)
  return 200;
}

// ── ABI Encoding Helpers (remove/fee collection only — SDK handles add) ──

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
      // Align inward: ceil for lower bound (stay >= MIN_TICK), floor for upper (stay <= MAX_TICK).
      // Using floor for MIN_TICK would produce e.g. -887280 < -887272, causing SDK "Invariant failed: TICK".
      return {
        tickLower: Math.ceil(MIN_TICK / tickSpacing) * tickSpacing,
        tickUpper: Math.floor(MAX_TICK / tickSpacing) * tickSpacing,
      };
    case "wide": { // ±50% price, symmetric around nearest tickSpacing multiple
      const center = Math.round(currentTick / tickSpacing) * tickSpacing;
      const half = Math.ceil(5000 / tickSpacing) * tickSpacing;
      return { tickLower: center - half, tickUpper: center + half };
    }
    case "narrow": { // ±5% price, symmetric around nearest tickSpacing multiple
      const center = Math.round(currentTick / tickSpacing) * tickSpacing;
      const half = Math.ceil(500 / tickSpacing) * tickSpacing;
      return { tickLower: center - half, tickUpper: center + half };
    }
    default: {
      const [lo, hi] = range.split(",").map(Number);
      if (isNaN(lo) || isNaN(hi)) throw new Error(`Invalid tick range: "${range}". Use "full", "wide", "narrow", or "tickLower,tickUpper".`);
      return { tickLower: alignTick(lo, tickSpacing), tickUpper: alignTick(hi, tickSpacing) };
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export interface AddLiquidityParams {
  tokenA: string;        // symbol or address
  tokenB: string;
  amountA?: string;      // human-readable amount of tokenA (optional — computed from amountB if omitted)
  amountB?: string;      // human-readable amount of tokenB (optional — computed from amountA if omitted)
                         // At least one of amountA or amountB must be provided.
  fee: number;           // fee in hundredths of a bip — e.g. 100, 500, 3000, 6000, 10000
                         // REQUIRED: Uniswap v4 has infinite fee tiers; must match the pool exactly.
  tickSpacing?: number;  // only needed for non-standard pools (auto-derived from fee otherwise)
  hooks?: Address;       // hook contract (default: zero address = no hook)
  tickRange?: string;    // "full" | "wide" | "narrow" | "tickLower,tickUpper"
}

/**
 * Build unsigned vault tx for adding liquidity to a Uniswap v4 pool.
 *
 * Uses the official @uniswap/v4-sdk to encode calldata:
 *   1. Read pool state from chain (sqrtPriceX96, tick, liquidity)
 *   2. Create SDK Pool + Position.fromAmounts (handles liquidity math)
 *   3. V4PositionManager.addCallParameters encodes modifyLiquidities calldata
 *   4. The calldata targets PositionManager but the vault adapter uses the same
 *      function signature — so we send it to the vault address directly.
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
  const raw0Input: string | undefined = isALower ? params.amountA : params.amountB;
  const raw1Input: string | undefined = isALower ? params.amountB : params.amountA;

  if (raw0Input === undefined && raw1Input === undefined) {
    throw new Error("At least one of amountA or amountB must be provided.");
  }

  // 2. Get token decimals on-chain
  const [dec0, dec1] = await Promise.all([
    getTokenDecimals(chainId, currency0, env.ALCHEMY_API_KEY),
    getTokenDecimals(chainId, currency1, env.ALCHEMY_API_KEY),
  ]);

  // 3. Build pool key and SDK Token/Currency objects
  const fee = params.fee;
  const tickSpacing = params.tickSpacing ?? defaultTickSpacing(fee);
  const hooks = params.hooks ?? ZERO_ADDRESS;

  const poolKey: PoolKey = { currency0, currency1, fee, tickSpacing, hooks };
  const poolId = computePoolId(poolKey);

  const sdkToken0 = toCurrency(chainId, currency0, dec0);
  const sdkToken1 = toCurrency(chainId, currency1, dec1);

  // 4. Read current pool state (validates the pool exists on this chain)
  let poolState: PoolState;
  try {
    poolState = await readPoolState(poolId, chainId, env.ALCHEMY_API_KEY);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Pool not found on chain ${chainId} with fee=${fee / 10000}%, tickSpacing=${tickSpacing}, hooks=${hooks}. ` +
      `Uniswap v4 requires an exact pool key match. ` +
      `Use get_pool_info with the pool ID to discover the correct fee and tickSpacing. ` +
      `(${msg})`
    );
  }

  // 5. Resolve tick range
  const range = params.tickRange ?? "full";
  const { tickLower, tickUpper } = resolveTickRange(range, poolState.tick, tickSpacing);

  // 6. Create SDK Pool object from on-chain state
  const pool = new Pool(
    sdkToken0, sdkToken1,
    fee, tickSpacing, hooks,
    poolState.sqrtPriceX96.toString(),
    poolState.liquidity.toString(),
    poolState.tick,
  );

  // 7. Create Position — use the correct SDK method based on which amounts are provided.
  //    Position.fromAmounts takes min(liq_from_amount0, liq_from_amount1), so passing 0
  //    for one side when the tick is in range always yields zero liquidity.
  //    Instead, use fromAmount0 or fromAmount1 for single-sided input.
  const amount0 = raw0Input !== undefined ? parseUnits(raw0Input, dec0) : 0n;
  const amount1 = raw1Input !== undefined ? parseUnits(raw1Input, dec1) : 0n;

  let position: Position;
  if (raw0Input !== undefined && raw1Input !== undefined) {
    // Both amounts provided — use fromAmounts (takes min liquidity of both)
    position = Position.fromAmounts({
      pool, tickLower, tickUpper,
      amount0: amount0.toString(),
      amount1: amount1.toString(),
      useFullPrecision: true,
    });
  } else if (raw1Input !== undefined) {
    // Only amount1 provided — derive position from amount1, SDK computes amount0
    position = Position.fromAmount1({
      pool, tickLower, tickUpper,
      amount1: amount1.toString(),
    });
  } else {
    // Only amount0 provided — derive position from amount0, SDK computes amount1
    position = Position.fromAmount0({
      pool, tickLower, tickUpper,
      amount0: amount0.toString(),
      useFullPrecision: true,
    });
  }

  if (position.liquidity.toString() === "0") {
    throw new Error("Computed liquidity is zero — check that amounts and tick range are valid for the current pool price.");
  }

  // 8. Check for an existing position with the same pool key and tick range.
  //    If one exists, increase it instead of minting a new position (avoids duplicate NFTs).
  let existingTokenId: bigint | undefined;
  try {
    const existing = await getVaultLPPositions(chainId, vaultAddress, env.ALCHEMY_API_KEY);
    const match = existing.find(p =>
      p.currency0.toLowerCase() === currency0.toLowerCase() &&
      p.currency1.toLowerCase() === currency1.toLowerCase() &&
      p.fee === fee &&
      p.tickSpacing === tickSpacing &&
      p.hooks.toLowerCase() === hooks.toLowerCase() &&
      p.tickLower === tickLower &&
      p.tickUpper === tickUpper &&
      p.liquidity !== "0",
    );
    if (match) {
      existingTokenId = BigInt(match.tokenId);
      console.log(`[buildAddLiquidityTx] Reusing existing position #${match.tokenId} (same pool + tick range) — increasing instead of minting`);
    }
  } catch {
    // If position lookup fails, fall through to minting a new position
  }

  // 9. Encode calldata via SDK — produces modifyLiquidities(unlockData, deadline)
  //    The vault adapter has the same function signature, so the calldata works as-is.
  //    Pass tokenId for INCREASE_LIQUIDITY, or recipient for MINT_POSITION.
  const deadline = Math.floor(Date.now() / 1000) + 1800; // 30 min
  const addOptions = existingTokenId !== undefined
    ? { tokenId: existingTokenId.toString(), slippageTolerance: new Percent(1, 100), deadline }
    : { recipient: vaultAddress, slippageTolerance: new Percent(1, 100), deadline };
  const { calldata: sdkCalldata } = V4PositionManager.addCallParameters(position, addOptions);

  const sym0 = isALower ? params.tokenA : params.tokenB;
  const sym1 = isALower ? params.tokenB : params.tokenA;
  const raw0 = raw0Input ?? formatUnits(BigInt(position.amount0.quotient.toString()), dec0);
  const raw1 = raw1Input ?? formatUnits(BigInt(position.amount1.quotient.toString()), dec1);
  const action = existingTokenId !== undefined ? `Increase position #${existingTokenId}` : "Add liquidity";
  const description = `[Uniswap v4] ${action}: ${raw0} ${sym0} + ${raw1} ${sym1} (${range} range, fee ${fee / 10000}%)`;

  return { calldata: sdkCalldata as Hex, description, poolId, tickLower, tickUpper };
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
  // Default: do NOT burn the NFT — leave it as a closed (0-liquidity) position
  // that can be reused or explicitly cleaned up with burn_position later.
  const shouldBurn = params.burn === true;

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
  // ownerOf(uint256 tokenId) → address (ERC-721)
  {
    name: "ownerOf",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "tokenId", type: "uint256" as const }],
    outputs: [{ name: "owner", type: "address" as const }],
  },
] as const;

// ── Pool Info Lookup ───────────────────────────────────────────────────

/** Uniswap v4 PoolManager Initialize event ABI fragment (for getLogs). */
const INITIALIZE_EVENT_ABI = [{
  type: "event" as const,
  name: "Initialize",
  inputs: [
    { name: "id",          type: "bytes32"  as const, indexed: true  },
    { name: "currency0",   type: "address"  as const, indexed: true  },
    { name: "currency1",   type: "address"  as const, indexed: true  },
    { name: "fee",         type: "uint24"   as const, indexed: false },
    { name: "tickSpacing", type: "int24"    as const, indexed: false },
    { name: "hooks",       type: "address"  as const, indexed: false },
    { name: "sqrtPriceX96",type: "uint160"  as const, indexed: false },
    { name: "tick",        type: "int24"    as const, indexed: false },
  ],
}] as const;

export interface PoolInfo {
  /** The keccak256(abi.encode(PoolKey)) pool ID. */
  poolId: Hex;
  initialized: boolean;
  /** Fee tier in hundredths of a bip (e.g. 6000 = 0.60%). */
  fee: number;
  /** Tick spacing — always exact (from Initialize event or provided). */
  tickSpacing: number;
  /** Hook contract address (zero = no hook). */
  hooks: Address;
  currency0: Address;
  currency1: Address;
  sqrtPriceX96: string;
  currentTick: number;
}

/**
 * Look up full pool key details for a Uniswap v4 pool by its pool ID.
 *
 * Reads slot0 (sqrtPriceX96, tick, lpFee) via StateView.getSlot0(), then
 * fetches the PoolManager Initialize event to recover tickSpacing and hooks.
 *
 * All together the returned PoolInfo contains everything required to call
 * add_liquidity on that pool.
 */
export async function getPoolInfoById(
  poolId: Hex,
  chainId: number,
  alchemyApiKey: string,
): Promise<PoolInfo> {
  const stateView = STATE_VIEW[chainId];
  if (!stateView) {
    throw new Error(`Uniswap v4 StateView not available on chain ${chainId}.`);
  }
  const poolManager = POOL_MANAGER[chainId];
  if (!poolManager) {
    throw new Error(`Uniswap v4 PoolManager not available on chain ${chainId}.`);
  }

  const client = getClient(chainId, alchemyApiKey);

  // 1. Read slot0 via StateView
  const slot0Result = await client.readContract({
    address: stateView,
    abi: STATEVIEW_ABI,
    functionName: "getSlot0",
    args: [poolId],
  });

  const sqrtPriceX96 = slot0Result[0];
  const tick = slot0Result[1];
  const lpFee = slot0Result[3];

  if (sqrtPriceX96 === 0n) {
    throw new Error(`Pool ${poolId} not found or not initialized on chain ${chainId}.`);
  }

  // 2. Fetch Initialize event to recover tickSpacing, hooks, and token addresses
  let fee: number = lpFee;
  let tickSpacing: number = defaultTickSpacing(lpFee);
  let hooks: Address = "0x0000000000000000000000000000000000000000" as Address;
  let currency0: Address = "0x0000000000000000000000000000000000000000" as Address;
  let currency1: Address = "0x0000000000000000000000000000000000000000" as Address;

  try {
    const logs = await client.getLogs({
      address: poolManager,
      event: INITIALIZE_EVENT_ABI[0],
      args: { id: poolId },
      fromBlock: 0n,
      toBlock: "latest",
    });
    if (logs.length > 0 && logs[0].args) {
      const e = logs[0].args;
      fee         = Number(e.fee ?? lpFee);
      tickSpacing = Number(e.tickSpacing ?? defaultTickSpacing(lpFee));
      hooks       = (e.hooks ?? "0x0000000000000000000000000000000000000000") as Address;
      currency0   = (e.currency0 ?? currency0) as Address;
      currency1   = (e.currency1 ?? currency1) as Address;
    }
  } catch {
    // Initialize event lookup failed (node limitation) — fee from slot0, ts estimated
  }

  return {
    poolId,
    initialized: true,
    fee,
    tickSpacing,
    hooks,
    currency0,
    currency1,
    sqrtPriceX96: sqrtPriceX96.toString(),
    currentTick: tick,
  };
}

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
  /** "active" = non-zero liquidity; "closed" = 0 liquidity, NFT still exists in POSM */
  status?: "active" | "closed";
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
  const stateView = STATE_VIEW[chainId];
  if (!stateView) throw new Error(`Uniswap v4 StateView not available on chain ${chainId}.`);

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

  if (rawPositions.length === 0) {
    // If the vault returned token IDs but all POSM calls failed, that is a data
    // error (wrong POSM address, RPC issue, ABI mismatch) — not "no positions".
    // Throw so the caller can surface a real error instead of silently returning [].
    if (tokenIds.length > 0) {
      const failures = tokenIds.map((id, i) => {
        const info = posmResults[i * 2];
        const liq = posmResults[i * 2 + 1];
        return `#${id}: info=${info.status}, liq=${liq.status}`;
      }).join("; ");
      throw new Error(
        `Vault has ${tokenIds.length} position ID(s) but all PositionManager queries failed. ` +
        `This is likely an RPC issue. Details: ${failures}`,
      );
    }
    return [];
  }

  // 4. Build batch calls: pool prices (StateView) + token symbol/decimals
  const tokenList = [...uniqueTokens];
  const poolList = [...uniquePoolIds.values()];

  const enrichCalls = [
    // Pool sqrtPriceX96 via StateView.getSlot0
    ...poolList.map(({ poolId }) => ({
      address: stateView!,
      abi: STATEVIEW_ABI,
      functionName: "getSlot0" as const,
      args: [poolId] as const,
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
      const [sqrtPriceX96] = result.result as [bigint, number, number, number];
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
      // Positions with 0 liquidity are closed (fees may still be claimable)
      status: rp.liquidity > 0n ? "active" as const : "closed" as const,
    });
  }

  return positions;
}

// ── Single-position POSM query (for burn fallback) ─────────────────────

/**
 * Directly query the POSM for a single position's pool key and liquidity.
 * This is a lightweight fallback for `burn_position` when `getVaultLPPositions`
 * drops the position (e.g. transient RPC failure in the batch multicall).
 *
 * Returns null if the NFT has already been burned in the POSM (position info
 * zeroed out).
 */
export async function getPositionDirect(
  chainId: number,
  tokenId: string,
  alchemyApiKey: string,
): Promise<{ currency0: Address; currency1: Address; liquidity: bigint } | null> {
  const posm = POSITION_MANAGER[chainId];
  if (!posm) return null;

  const client = getClient(chainId, alchemyApiKey);
  const tokenIdBn = BigInt(tokenId);

  const results = await client.multicall({
    contracts: [
      {
        address: posm,
        abi: POSITION_MANAGER_ABI,
        functionName: "getPoolAndPositionInfo" as const,
        args: [tokenIdBn] as const,
      },
      {
        address: posm,
        abi: POSITION_MANAGER_ABI,
        functionName: "getPositionLiquidity" as const,
        args: [tokenIdBn] as const,
      },
    ],
  });

  const infoResult = results[0];
  const liqResult = results[1];

  if (infoResult.status !== "success" || !infoResult.result) return null;

  const [poolKey, _packedInfo] = infoResult.result as [
    { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address },
    bigint,
  ];

  // If the pool key is all zeros, the position info was deleted (NFT burned in POSM)
  if (poolKey.currency0 === "0x0000000000000000000000000000000000000000" &&
      poolKey.currency1 === "0x0000000000000000000000000000000000000000") {
    return null;
  }

  const liquidity = liqResult.status === "success" ? (liqResult.result as bigint) : 0n;

  return {
    currency0: poolKey.currency0,
    currency1: poolKey.currency1,
    liquidity,
  };
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

// ── Position Burn ──────────────────────────────────────────────────────

/**
 * Build unsigned vault tx to burn a closed (0-liquidity) Uniswap v4 LP position NFT.
 *
 * Action sequence: DECREASE_LIQUIDITY(0) → TAKE_PAIR → BURN_POSITION
 *
 * Even when liquidity is already 0, the PositionManager requires DECREASE_LIQUIDITY
 * to flush any residual fee accounting, TAKE_PAIR to settle balances back to the
 * vault, and BURN_POSITION to delete the NFT. Using BURN_POSITION alone reverts.
 * This matches the `0x011103` action sequence observed in confirmed burn transactions.
 *
 * Pre-conditions (caller must verify before calling this):
 *   1. Position liquidity == 0 (confirmed by get_lp_positions showing Status: Closed)
 *   2. Fees should be collected first (collect_lp_fees) — any residual settled to vault
 *
 * @param tokenId    ERC-721 position token ID to burn
 * @param currency0  Sorted lower token address of the pool pair
 * @param currency1  Sorted higher token address of the pool pair
 * @param vaultAddress  The vault that owns the position NFT
 */
export function buildBurnPositionTx(
  tokenId: string,
  currency0: Address,
  currency1: Address,
  vaultAddress: Address,
): { calldata: Hex; description: string } {
  const tokenIdBn = BigInt(tokenId);

  // Must be DECREASE_LIQUIDITY(0) + TAKE_PAIR + BURN_POSITION — not just BURN_POSITION alone.
  // POSM requires the full sequence to flush fee accounting even when liquidity is 0.
  const unlockData = buildUnlockData(
    [Actions.DECREASE_LIQUIDITY, Actions.TAKE_PAIR, Actions.BURN_POSITION],
    [
      encodeDecreaseParams(tokenIdBn, 0n, 0n, 0n),
      encodeTakePairParams(currency0, currency1, vaultAddress),
      encodeBurnParams(tokenIdBn, 0n, 0n),
    ],
  );

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const calldata = encodeVaultModifyLiquidities(unlockData, deadline);

  const description = `[Uniswap v4] Burn position NFT #${tokenId} (permanent)`;
  return { calldata, description };
}
