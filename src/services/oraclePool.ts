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
 * Two paths depending on whether `vaultAddress` is provided:
 *   - **EOA path** (no `vaultAddress`): targets the Universal Router. The operator
 *     signs with their personal wallet and sends `msg.value = amountIn`. No vault
 *     delegation required.
 *   - **Vault path** (`vaultAddress` provided): targets the vault's `execute()`
 *     adapter with `value = 0`. Settlement is sourced from the vault's own native
 *     balance. Supports delegation and the NAV shield. The swap is exact-input
 *     with amountOutMinimum=0 — output is not bounded on-chain.
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  parseUnits,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { getTokenDecimals } from "./vault.js";
import { getClient } from "./rpcClient.js";
import { resolveTokenAddress, TOKEN_MAP, NATIVE_TOKEN, getNativeTokenSymbol } from "../config.js";
import { TickMath } from "@uniswap/v3-sdk";
import { BACKGEO_ORACLE_ABI } from "./oracleAbi.js";

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
export const UNIVERSAL_ROUTER: Record<number, Address> = {
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
  /**
   * Unsigned transaction for the oracle refresh.
   * - When `operatorOnly` is `true` (EOA path): targets the Universal Router;
   *   the operator signs with their personal wallet and sends `msg.value = amountIn`.
   * - When `operatorOnly` is absent/false (vault path): targets the vault adapter
   *   (`vault.execute`); `value = 0` and can be delegated or relayed.
   */
  transaction: {
    to: Address;
    data: Hex;
    value: string;   // hex wei string
    chainId: number;
    description: string;
    operatorOnly?: boolean;
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
  /** Parsed input amount in wei — useful for pre-flight checks in callers. */
  amountInWei: bigint;
  /** Token decimals (for sell direction) or 18 (for buy direction). */
  tokenDecimals: number;
  message: string;
}

// ── Main Function ───────────────────────────────────────────────────────

/**
 * Build an unsigned transaction that swaps a small native-token amount on the
 * BackgeoOracle V4 pool to refresh stale price observations.
 *
 * Two paths are supported:
 *   1. **Vault path** (`vaultAddress` provided): the calldata targets the vault's
 *      `execute()` adapter with `value = 0`. The external `vault.execute` call is
 *      non-payable, so no `msg.value` is sent by the caller. Internally, Uniswap
 *      V4's `SETTLE_ALL` action requires the native token to be present at execution
 *      time — but the vault adapter sources this payment from the vault's own native
 *      balance, not from `msg.value`. This path supports delegation and the NAV
 *      shield. The swap is exact-input with amountOutMinimum=0 — output amount
 *      is not bounded on-chain (NAV shield enforces a value-level check instead).
 *   2. **EOA path** (`vaultAddress` omitted): the calldata targets the Uniswap
 *      Universal Router directly. The operator sends `msg.value = amountIn` and
 *      signs with their personal wallet.
 *
 * @param token - Token symbol or address whose oracle feed is stale (e.g., "GRG").
 * @param amountIn - Amount to swap. For "buy" direction: chain's native token amount.
 *   For "sell" direction: ERC-20 token amount. Must be provided by the caller; there is no default.
 * @param chainId - Chain where the oracle is stale.
 * @param alchemyKey - Alchemy API key for RPC calls.
 * @param vaultAddress - Optional vault address. If provided, the transaction targets
 *   the vault adapter instead of the Universal Router.
 * @param direction - "buy" (chain's native token → ERC-20, default) or "sell" (ERC-20 → chain's native token).
 */
export async function buildOraclePoolSwapTx(
  token: string,
  amountIn: string,
  chainId: number,
  alchemyKey: string,
  vaultAddress?: Address,
  direction: "buy" | "sell" = "buy",
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

  if (vaultAddress !== undefined && vaultAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("vaultAddress must be a valid non-zero vault address.");
  }

  // Resolve token address — normalize ETH aliases and wrapped-native to address(0)
  const rawTokenAddr = await resolveTokenAddress(chainId, token);
  const nativeSymbol = getNativeTokenSymbol(chainId);
  const wrappedNativeAddr = (TOKEN_MAP[chainId]?.[`W${nativeSymbol}`] as string | undefined)?.toLowerCase();
  const tokenAddr: Address =
    rawTokenAddr.toLowerCase() === ETH_ADDRESS ||
    rawTokenAddr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ||
    (wrappedNativeAddr !== undefined && rawTokenAddr.toLowerCase() === wrappedNativeAddr)
      ? ETH_ADDRESS
      : rawTokenAddr;

  if (tokenAddr === ETH_ADDRESS) {
    throw new Error(
      `${nativeSymbol}/W${nativeSymbol} does not need an oracle update — it is always currency0. ` +
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

  // Verify oracle pool is initialized and read the current spot tick in one
  // Multicall3 round-trip: getState(cardinality) + observe(tickCumulatives).
  const client = getClient(chainId, alchemyKey);
  let cardinality: number;
  let priceLine = "";
  try {
    const [stateResult, observeResult] = await client.multicall({
      contracts: [
        { address: oracle, abi: BACKGEO_ORACLE_ABI, functionName: "getState", args: [poolKey] },
        { address: oracle, abi: BACKGEO_ORACLE_ABI, functionName: "observe", args: [poolKey, [0, 1]] },
      ],
    });

    if (stateResult.status !== "success") {
      throw new Error(stateResult.error?.message || "getState failed");
    }
    cardinality = stateResult.result.cardinality;

    if (observeResult.status === "success") {
      const tickCumulatives = (observeResult.result as unknown as [bigint[], bigint[]])[0];
      const tick = Number(tickCumulatives[0] - tickCumulatives[1]);
      if (Number.isFinite(tick)) {
        const sqrtRatio = TickMath.getSqrtRatioAtTick(Math.round(tick));
        const sqrtPriceX96 = BigInt(sqrtRatio.toString());
        const priceNum = sqrtPriceX96 * sqrtPriceX96;
        const priceDenom = 2n ** 192n;
        const price = Number(priceNum) / Number(priceDenom);
        if (price > 0 && Number.isFinite(price)) {
          const tokenPerNative = price;
          const nativePerToken = 1 / price;
          const outSymbol = token.toUpperCase();
          priceLine = `Pool price: 1 ${nativeSymbol} = ${tokenPerNative.toPrecision(6)} ${outSymbol}  (1 ${outSymbol} = ${nativePerToken.toPrecision(6)} ${nativeSymbol})`;
        }
      }
    }
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

  // Parse input amount (native token for buy, ERC-20 token for sell)
  const isBuy = direction === "buy";
  let amountInWei: bigint;
  let tokenDecimals: number;
  try {
    if (isBuy) {
      tokenDecimals = 18;
      amountInWei = parseUnits(amountIn, 18);
    } else {
      tokenDecimals = await getTokenDecimals(chainId, tokenAddr, alchemyKey);
      amountInWei = parseUnits(amountIn, tokenDecimals);
    }
  } catch {
    throw new Error(
      `Invalid decimal: "${amountIn}" has too many decimal places for the token. ` +
      `Use a smaller precision (e.g. "0.001"). Scientific notation is not supported.`
    );
  }
  if (amountInWei <= 0n) {
    throw new Error(
      `amount must be a positive value; received "${amountIn}".`
    );
  }

  const viaVault = !!vaultAddress;

  // ── Build V4 SWAP_EXACT_IN_SINGLE calldata ────────────────────────────
  //
  // Actions: [SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f)]
  //
  // param[0] — ExactInputSingleParams:
  //   PoolKey, zeroForOne=true, amountIn, amountOutMin=0, hookData=0x
  //
  // param[1] — SETTLE_ALL: (currencyIn, maxAmount)
  //   EOA path: settles ETH from msg.value. Vault path: settles from the vault's own
  //   native balance (vault.execute is non-payable, so value=0; the vault adapter
  //   sources the native token internally). maxAmount = amountIn ensures no over-settling.
  //
  // param[2] — TAKE_ALL: (currencyOut, minAmount=0)
  //   Takes all token output and sends to msg.sender.
  //   EOA path: msg.sender is the operator, so the operator receives the output token.
  //   Vault path: msg.sender is the vault adapter, so the output token stays in the vault.

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
      isBuy,         // zeroForOne: true = ETH (c0) → token (c1), false = token (c1) → ETH (c0)
      amountInWei,   // uint128 amountIn
      0n,            // amountOutMinimum: no minimum — oracle updates accept any output
      "0x" as Hex,   // hookData: empty
    ],
  );

  const settleParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    isBuy ? [ETH_ADDRESS, amountInWei] : [tokenAddr, amountInWei],  // SETTLE_ALL: settle input currency
  );

  const takeParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    isBuy ? [tokenAddr, 0n] : [ETH_ADDRESS, 0n],  // TAKE_ALL: take output currency, minimum = 0
  );

  // Pack actions and params into V4 swap input
  const v4SwapInput = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [V4_EXACT_IN_ACTIONS, [swapParam, settleParam, takeParam]],
  );

  // Encode Universal Router execute(commands, inputs, deadline)
  // Vault/delegated path uses 30 minutes to accommodate queuing and user review;
  // EOA path uses 5 minutes since the user signs and broadcasts immediately.
  const deadlineSeconds = viaVault ? 1800 : 300;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  const calldata = encodeFunctionData({
    abi: UR_EXECUTE_ABI,
    functionName: "execute",
    args: [V4_SWAP_COMMAND, [v4SwapInput], deadline],
  });

  // Derive a user-friendly token symbol for the description
  const tokenSymbol = token.toUpperCase();

  if (viaVault) {
    const vaultDescription = isBuy
      ? `Oracle refresh: ${amountIn} ${nativeSymbol} → ${tokenSymbol} (vault)`
      : `Oracle refresh: ${amountIn} ${tokenSymbol} → ${nativeSymbol} (vault)`;

    const message = [
      `🔄 Oracle Refresh Ready (Vault)`,
      `Direction: ${isBuy ? `${nativeSymbol} → ${tokenSymbol}` : `${tokenSymbol} → ${nativeSymbol}`}`,
      `Amount: ${amountIn} ${isBuy ? nativeSymbol : tokenSymbol}`,
      priceLine,
      ``,
      `Executes through the vault adapter — eligible for delegation.`,
    ].filter(Boolean).join("\n");

    return {
      transaction: {
        to: vaultAddress!,
        data: calldata,
        value: "0x0",
        chainId,
        description: vaultDescription,
      },
      poolInfo: {
        oracle,
        currency0: ETH_ADDRESS,
        currency1: tokenAddr,
        tokenSymbol,
        poolId,
        cardinality,
      },
      amountInWei,
      tokenDecimals,
      message,
    };
  }

  // EOA path
  const eoaDescription = isBuy
    ? `Oracle refresh: ${amountIn} ${nativeSymbol} → ${tokenSymbol} (EOA)`
    : `Oracle refresh: ${amountIn} ${tokenSymbol} → ${nativeSymbol} (EOA)`;

  const message = [
    `🔄 Oracle Refresh Ready`,
    `Direction: ${isBuy ? `${nativeSymbol} → ${tokenSymbol}` : `${tokenSymbol} → ${nativeSymbol}`}`,
    `Amount: ${amountIn} ${isBuy ? nativeSymbol : tokenSymbol}`,
    priceLine,
    ``,
    `⚠️ Sign with your operator wallet — sent directly to the Universal Router.`,
  ].filter(Boolean).join("\n");

  return {
    transaction: {
      to: universalRouter,
      data: calldata,
      value: isBuy ? "0x" + amountInWei.toString(16) : "0x0",
      chainId,
      description: eoaDescription,
      operatorOnly: true,
    },
    poolInfo: {
      oracle,
      currency0: ETH_ADDRESS,
      currency1: tokenAddr,
      tokenSymbol,
      poolId,
      cardinality,
    },
    amountInWei,
    tokenDecimals,
    message,
  };
}
