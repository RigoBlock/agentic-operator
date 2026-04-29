/**
 * BackgeoOracle Pool Swap Service
 *
 * Builds unsigned transactions that swap a small amount on the BackgeoOracle's
 * dedicated Uniswap V4 pool. This creates a new price observation in the oracle
 * hook, allowing a stale TWAP feed to converge toward the current market price.
 *
 * ## Architecture
 *
 * The BackgeoOracle is a Uniswap V4 hook. It records price observations via
 * its `afterSwap` callback when swaps happen on pools configured with it as the
 * hook. The pool key for a token's oracle pool is always:
 *
 *   {currency0: ETH (0x0), currency1: token, fee: 0, tickSpacing: 32767, hooks: oracle}
 *
 * By swapping on this pool, we trigger the hook and create a fresh observation.
 * The 5-minute TWAP will then start converging toward the new pool price.
 *
 * ## Why staleness occurs
 *
 * If nobody trades on the oracle pool, no new observations are recorded and the
 * TWAP reflects the last traded price (potentially weeks old). On low-volume
 * chains (e.g., GRG/ETH on Arbitrum), this divergence can reach 2× or more.
 *
 * ## Transaction type
 *
 * Returns an OPERATOR EOA transaction (to: Universal Router, not the vault).
 * The operator signs with their personal wallet. No vault delegation required.
 * Value = amountIn (ETH for ETH→token swaps).
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  parseUnits,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { getClient } from "./vault.js";
import { resolveTokenAddress } from "../config.js";

// ── BackgeoOracle contract addresses per chain ─────────────────────────
// Source: https://github.com/RigoBlock/v3-contracts/blob/development/src/utils/constants.ts
export const BACKGEO_ORACLE: Record<number, Address> = {
  1:     "0xB13250f0Dc8ec6dE297E81CDA8142DB51860BaC4", // Ethereum
  10:    "0x79234983dED8EAA571873fffe94e437e11C7FaC4", // Optimism
  56:    "0x77B2051204306786934BE8bEC29a48584E133aC4", // BNB Chain
  130:   "0x54bd666eA7FD8d5404c0593Eab3Dcf9b6E2A3aC4", // Unichain
  137:   "0x1D8691A1A7d53B60DeDd99D8079E026cB0E5bac4", // Polygon
  8453:  "0x59f39091Fd6f47e9D0bCB466F74e305f1709BAC4", // Base
  42161: "0x3043e182047F8696dFE483535785ed1C3681baC4", // Arbitrum
};

// ── Uniswap V4 Universal Router addresses per chain ──────────────────────
// Source: https://github.com/RigoBlock/v3-contracts/blob/development/src/utils/constants.ts
// (These are the standard Uniswap V2 Universal Router deployments.)
const UNIVERSAL_ROUTER: Record<number, Address> = {
  1:     "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af", // Ethereum
  10:    "0x851116D9223fabED8E56C0E6b8Ad0c31d98B3507", // Optimism
  56:    "0x1906c1d672b88cD1B9aC7593301cA990F94Eae07", // BNB Chain
  130:   "0xEf740bf23aCaE26f6492B10de645D6B98dC8Eaf3", // Unichain
  137:   "0x1095692A6237d83C6a72F3F5eFEdb9A670C49223", // Polygon
  8453:  "0x6fF5693b99212Da76ad316178A184AB56D299b43", // Base
  42161: "0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3", // Arbitrum
};

// ── Universal Router ABI ───────────────────────────────────────────────

const UR_EXECUTE_ABI = [
  {
    name: "execute",
    type: "function" as const,
    stateMutability: "payable" as const,
    inputs: [
      { name: "commands", type: "bytes" as const },
      { name: "inputs", type: "bytes[]" as const },
      { name: "deadline", type: "uint256" as const },
    ],
    outputs: [],
  },
] as const;

// ── BackgeoOracle ABI (for pool state queries) ─────────────────────────

const ORACLE_ABI = [
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

// ── V4 Universal Router constants ──────────────────────────────────────

/** Universal Router V2 command byte for V4 swaps. */
const V4_SWAP_COMMAND = "0x10" as Hex;

/**
 * V4Router action bytes (post-Nov-2024 PR #384 codes).
 * Packed as a 3-byte sequence: [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL].
 */
const V4_EXACT_IN_ACTIONS = "0x060c0f" as Hex;

/** ETH native address (currency0 in oracle pools — always lowest address). */
const ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** Maximum tick spacing in Uniswap V4. Oracle pools use this value. */
const MAX_TICK_SPACING = 32767;

/** Oracle pools use fee = 0 (observations are protocol-level, not LP fee). */
const ORACLE_POOL_FEE = 0;

/** Gas limit for oracle pool swap — V4 swap + hook callback overhead. */
const ORACLE_SWAP_GAS_LIMIT = 400_000n;

// ── Types ──────────────────────────────────────────────────────────────

export interface OraclePoolSwapResult {
  /** Transaction to be signed by the operator EOA (not vault). */
  transaction: {
    to: Address;
    data: Hex;
    value: string;   // hex wei string
    chainId: number;
    gas: string;     // hex
    description: string;
  };
  /** Human-readable pool key summary for diagnostics. */
  poolInfo: {
    oracle: Address;
    currency0: Address;
    currency1: Address;
    tokenSymbol: string;
    poolId: Hex;
    cardinality: number;
  };
  message: string;
}

// ── Main Function ───────────────────────────────────────────────────────

/**
 * Build an unsigned EOA transaction that swaps a small ETH amount on the
 * BackgeoOracle V4 pool to refresh stale price observations.
 *
 * @param token - Token symbol or address whose oracle feed is stale (e.g., "GRG").
 * @param amountEth - Amount of ETH to swap (default "0.001"). Larger amounts
 *   move the pool price more aggressively toward market, converging the TWAP faster.
 * @param chainId - Chain where the oracle is stale.
 * @param alchemyKey - Alchemy API key for RPC calls.
 */
export async function buildOraclePoolSwapTx(
  token: string,
  amountEth: string = "0.001",
  chainId: number,
  alchemyKey: string,
): Promise<OraclePoolSwapResult> {
  const oracle = BACKGEO_ORACLE[chainId];
  if (!oracle) {
    throw new Error(
      `BackgeoOracle not deployed on chain ${chainId}. Supported chains: ${Object.keys(BACKGEO_ORACLE).join(", ")}.`,
    );
  }

  const universalRouter = UNIVERSAL_ROUTER[chainId];
  if (!universalRouter) {
    throw new Error(`Universal Router not available on chain ${chainId}.`);
  }

  // Resolve token address — normalize WETH/ETH to address(0)
  const rawTokenAddr = await resolveTokenAddress(chainId, token);
  const tokenAddr: Address =
    rawTokenAddr.toLowerCase() === ETH_ADDRESS ||
    rawTokenAddr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      ? ETH_ADDRESS
      : rawTokenAddr;

  if (tokenAddr === ETH_ADDRESS) {
    throw new Error(
      "ETH/WETH does not need an oracle update — it is always currency0. " +
      "Please specify the token whose oracle feed is stale (e.g., 'GRG').",
    );
  }

  // Oracle pool key: (ETH, token, fee=0, tickSpacing=32767, hooks=oracle)
  // ETH (address(0)) is always currency0 since it has the lowest address value.
  const poolKey = {
    currency0: ETH_ADDRESS,
    currency1: tokenAddr,
    fee: ORACLE_POOL_FEE,
    tickSpacing: MAX_TICK_SPACING,
    hooks: oracle,
  };

  // Compute pool ID (keccak256 of ABI-encoded PoolKey)
  const poolId = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [poolKey.currency0, poolKey.currency1, ORACLE_POOL_FEE, MAX_TICK_SPACING, oracle],
    ),
  );

  // Verify oracle pool is initialized (cardinality > 0 means at least one observation exists)
  const client = getClient(chainId, alchemyKey);
  let cardinality: number;
  try {
    const state = await client.readContract({
      address: oracle,
      abi: ORACLE_ABI,
      functionName: "getState",
      args: [poolKey],
    });
    cardinality = state.cardinality;
  } catch (err) {
    throw new Error(
      `Failed to query BackgeoOracle state for ${token} on chain ${chainId}: ` +
      (err instanceof Error ? err.message : String(err)) +
      ". The oracle pool may not be initialized yet.",
    );
  }

  if (cardinality === 0) {
    throw new Error(
      `BackgeoOracle pool for ${token} on chain ${chainId} has not been initialized (cardinality = 0). ` +
      "This pool needs to be seeded with liquidity and initialized by the RigoBlock protocol before oracle refreshes can be triggered.",
    );
  }

  // Parse ETH input amount
  const amountInWei = parseUnits(amountEth, 18);

  // ── Build V4 SWAP_EXACT_IN_SINGLE calldata ────────────────────────────
  //
  // Actions: [SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f)]
  //
  // param[0] — ExactInputSingleParams:
  //   PoolKey, zeroForOne=true, amountIn, amountOutMin=0, hookData=0x
  //
  // param[1] — SETTLE_ALL: (currencyIn, maxAmount)
  //   Settles ETH from msg.value. maxAmount = amountIn ensures no over-settling.
  //
  // param[2] — TAKE_ALL: (currencyOut, minAmount=0)
  //   Takes all token output and sends to msg.sender (the operator).

  const swapParam = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { type: "bool" },    // zeroForOne
      { type: "uint128" }, // amountIn
      { type: "uint128" }, // amountOutMinimum (0 = accept any; this is a tiny oracle-update trade)
      { type: "bytes" },   // hookData (empty)
    ],
    [
      {
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks,
      },
      true,          // zeroForOne: ETH (c0) → token (c1)
      amountInWei,   // uint128 amountIn
      0n,            // amountOutMinimum: no minimum — oracle updates accept any output
      "0x" as Hex,   // hookData: empty
    ],
  );

  const settleParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [ETH_ADDRESS, amountInWei],  // SETTLE_ALL: settle ETH, cap at amountIn
  );

  const takeParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [tokenAddr, 0n],  // TAKE_ALL: take token, minimum = 0
  );

  // Pack actions and params into V4 swap input
  const v4SwapInput = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [V4_EXACT_IN_ACTIONS, [swapParam, settleParam, takeParam]],
  );

  // Encode Universal Router execute(commands, inputs, deadline)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5-minute deadline
  const calldata = encodeFunctionData({
    abi: UR_EXECUTE_ABI,
    functionName: "execute",
    args: [V4_SWAP_COMMAND, [v4SwapInput], deadline],
  });

  // Derive a user-friendly token symbol for the description
  const tokenSymbol = token.toUpperCase();
  const description =
    `Oracle pool refresh: swap ${amountEth} ETH → ${tokenSymbol} on BackgeoOracle V4 pool ` +
    `(chain ${chainId}) to create a new price observation. ` +
    `Sign with your operator wallet (NOT the vault).`;

  const message = [
    `🔄 Oracle Refresh Transaction Ready`,
    ``,
    `This swaps a small amount of ETH on the BackgeoOracle's dedicated Uniswap V4 pool`,
    `to create a fresh price observation. The 5-minute TWAP will start converging`,
    `toward the current market price after this swap is confirmed.`,
    ``,
    `Token: ${tokenSymbol}`,
    `Amount: ${amountEth} ETH → ${tokenSymbol}`,
    `Pool: fee=0, tickSpacing=32767, hooks=${oracle.slice(0, 10)}…`,
    `Oracle: ${oracle}`,
    `Pool ID: ${poolId.slice(0, 18)}…`,
    `Cardinality: ${cardinality} observations stored`,
    `Chain: ${chainId}`,
    ``,
    `⚠️ Sign this with your OPERATOR WALLET (EOA), NOT the vault.`,
    `The transaction goes directly to the Universal Router — not the vault adapter.`,
    `Gas limit: ${ORACLE_SWAP_GAS_LIMIT.toString()}`,
  ].join("\n");

  return {
    transaction: {
      to: universalRouter,
      data: calldata,
      value: "0x" + amountInWei.toString(16),
      chainId,
      gas: "0x" + ORACLE_SWAP_GAS_LIMIT.toString(16),
      description,
    },
    poolInfo: {
      oracle,
      currency0: ETH_ADDRESS,
      currency1: tokenAddr,
      tokenSymbol,
      poolId,
      cardinality,
    },
    message,
  };
}
