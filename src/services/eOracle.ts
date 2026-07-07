/**
 * On-chain EOracle wrapper.
 *
 * The Rigoblock pool (vault) delegates IEOracle selectors to the EOracle
 * extension, so we can call convertTokenAmount / convertBatchTokenAmounts
 * directly on the vault address.
 */

import { type Address, type Hex, encodeFunctionData } from "viem";
import { getClient } from "./rpcClient.js";
import { normalizeTokenAddress } from "./oraclePrice.js";

export const IEOracle_ABI = [
  {
    name: "convertTokenAmount",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "int256" },
      { name: "targetToken", type: "address" },
    ],
    outputs: [{ name: "convertedAmount", type: "int256" }],
  },
  {
    name: "convertBatchTokenAmounts",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "int256[]" },
      { name: "targetToken", type: "address" },
    ],
    outputs: [{ name: "totalConvertedAmount", type: "int256" }],
  },
] as const;

/**
 * Estimate the input amount required to obtain `amountOutRaw` of `tokenOut`
 * by calling the on-chain EOracle TWAP through the vault.
 *
 * Returns the estimated amount in `tokenIn` decimals.
 */
export async function estimateAmountInViaEOracle(
  chainId: number,
  vaultAddress: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountOutRaw: bigint,
  alchemyKey: string,
): Promise<bigint> {
  if (amountOutRaw <= 0n) {
    throw new Error("amountOut must be positive for EOracle conversion");
  }

  const normalizedIn = normalizeTokenAddress(tokenIn, chainId);
  const normalizedOut = normalizeTokenAddress(tokenOut, chainId);

  const client = getClient(chainId, alchemyKey);
  const converted = (await client.readContract({
    address: vaultAddress,
    abi: IEOracle_ABI,
    functionName: "convertTokenAmount",
    args: [normalizedOut, amountOutRaw, normalizedIn],
  })) as bigint;

  if (converted <= 0n) {
    throw new Error(
      `EOracle.convertTokenAmount returned a non-positive amountIn (${converted.toString()}) ` +
        `for ${tokenOut} → ${tokenIn} on chain ${chainId}`,
    );
  }

  return converted;
}

/**
 * Encode a call to EOracle.convertTokenAmount (useful for multicalls).
 */
export function encodeConvertTokenAmount(
  token: Address,
  amount: bigint,
  targetToken: Address,
): Hex {
  return encodeFunctionData({
    abi: IEOracle_ABI,
    functionName: "convertTokenAmount",
    args: [token, amount, targetToken],
  });
}

/**
 * Encode a call to EOracle.convertBatchTokenAmounts (useful for multicalls).
 */
export function encodeConvertBatchTokenAmounts(
  tokens: Address[],
  amounts: bigint[],
  targetToken: Address,
): Hex {
  return encodeFunctionData({
    abi: IEOracle_ABI,
    functionName: "convertBatchTokenAmounts",
    args: [tokens, amounts, targetToken],
  });
}
