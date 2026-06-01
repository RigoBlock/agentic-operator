/**
 * Quote Enrichment Service
 *
 * Adds oracle spot-price metadata to DEX API quotes.
 * Computes priceFeedExists, deltaBps, and oracleAmount.
 */

import type { Address } from "viem";
import { convertTokenAmountViaOracle, hasPriceFeedForPair } from "./oraclePrice.js";

export interface OracleEnrichment {
  /** Whether both tokens have an active BackgeoOracle price feed */
  priceFeedExists: boolean;
  /** Divergence between DEX expected output and oracle spot price, in basis points.
   *  Positive = DEX gives less than oracle. Negative = DEX gives more. */
  deltaBps: number;
  /** Expected output amount computed from the oracle spot price, in base units */
  oracleAmount: string;
}

/**
 * Enrich a DEX quote with oracle spot-price data.
 *
 * @param chainId - Chain ID
 * @param tokenIn - Input token address
 * @param tokenOut - Output token address
 * @param amountIn - Input amount in base units (string, e.g. "1000000000000000000")
 * @param dexExpectedOut - DEX expected output in base units (string)
 * @param alchemyKey - Alchemy API key for RPC
 */
export async function enrichQuoteWithOracle(
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: string,
  dexExpectedOut: string,
  alchemyKey: string,
): Promise<OracleEnrichment> {
  let priceFeedExists: boolean;
  try {
    priceFeedExists = await hasPriceFeedForPair(chainId, tokenIn, tokenOut, alchemyKey);
  } catch {
    return { priceFeedExists: false, deltaBps: 0, oracleAmount: "0" };
  }

  if (!priceFeedExists) {
    return { priceFeedExists: false, deltaBps: 0, oracleAmount: "0" };
  }

  try {
    const amountInBig = BigInt(amountIn);
    const oracleAmount = await convertTokenAmountViaOracle(
      chainId,
      tokenIn,
      amountInBig,
      tokenOut,
      alchemyKey,
    );

    if (oracleAmount === 0n) {
      return { priceFeedExists: true, deltaBps: 0, oracleAmount: "0" };
    }

    const dexOutBig = BigInt(dexExpectedOut);
    const deltaBps = Number(((oracleAmount - dexOutBig) * 10000n) / oracleAmount);

    return {
      priceFeedExists: true,
      deltaBps,
      oracleAmount: oracleAmount.toString(),
    };
  } catch (err) {
    console.warn(
      `[quoteEnrichment] Oracle enrichment failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return { priceFeedExists: true, deltaBps: 0, oracleAmount: "0" };
  }
}
