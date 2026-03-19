/**
 * Cross-chain token & configuration constants.
 *
 * Maps every bridgeable token per chain, matching the on-chain CrosschainTokens.sol
 * and CrosschainLib.sol validation logic exactly.
 *
 * @see https://github.com/RigoBlock/v3-contracts/blob/master/contracts/protocol/types/CrosschainTokens.sol
 * @see https://github.com/RigoBlock/v3-contracts/blob/master/contracts/protocol/libraries/CrosschainLib.sol
 */

import type { Address } from "viem";

// ── Operation types (must match Crosschain.sol OpType enum) ───────────

export enum OpType {
  Transfer = 0,
  Sync = 1,
}

// ── Across MulticallHandler addresses ─────────────────────────────────

export const DEFAULT_MULTICALL_HANDLER = "0x924a9f036260DdD5808007E1AA95f08eD08aA569" as Address;
export const BSC_MULTICALL_HANDLER = "0xAC537C12fE8f544D712d71ED4376a502EEa944d7" as Address;

export function getAcrossHandler(destinationChainId: number): Address {
  return destinationChainId === 56 ? BSC_MULTICALL_HANDLER : DEFAULT_MULTICALL_HANDLER;
}

// ── Across SpokePool addresses (per chain) ────────────────────────────

export const ACROSS_SPOKE_POOL: Record<number, Address> = {
  1:     "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5", // Ethereum
  10:    "0x6f26Bf09B1C792e3228e5467807a900A503c0281", // Optimism
  56:    "0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75", // BSC
  130:   "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", // Unichain
  137:   "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096", // Polygon
  8453:  "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", // Base
  42161: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A", // Arbitrum
};

// ── Bridgeable tokens per chain ───────────────────────────────────────
// Mirrors CrosschainTokens.sol exactly.

/** Token type identifiers for cross-group validation */
export type BridgeableTokenType = "USDC" | "USDT" | "WETH" | "WBTC";

export interface BridgeableToken {
  address: Address;
  type: BridgeableTokenType;
  symbol: string;
  decimals: number;
}

export const CROSSCHAIN_TOKENS: Record<number, BridgeableToken[]> = {
  1: [
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", type: "USDC", symbol: "USDC", decimals: 6 },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", type: "USDT", symbol: "USDT", decimals: 6 },
    { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", type: "WETH", symbol: "WETH", decimals: 18 },
    { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", type: "WBTC", symbol: "WBTC", decimals: 8 },
  ],
  42161: [
    { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", type: "USDC", symbol: "USDC", decimals: 6 },
    { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", type: "USDT", symbol: "USDT", decimals: 6 },
    { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", type: "WETH", symbol: "WETH", decimals: 18 },
    { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", type: "WBTC", symbol: "WBTC", decimals: 8 },
  ],
  10: [
    { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", type: "USDC", symbol: "USDC", decimals: 6 },
    { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", type: "USDT", symbol: "USDT", decimals: 6 },
    { address: "0x4200000000000000000000000000000000000006", type: "WETH", symbol: "WETH", decimals: 18 },
    { address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", type: "WBTC", symbol: "WBTC", decimals: 8 },
  ],
  8453: [
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", type: "USDC", symbol: "USDC", decimals: 6 },
    { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", type: "USDT", symbol: "USDT", decimals: 6 },
    { address: "0x4200000000000000000000000000000000000006", type: "WETH", symbol: "WETH", decimals: 18 },
  ],
  137: [
    { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", type: "USDC", symbol: "USDC", decimals: 6 },
    { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", type: "USDT", symbol: "USDT", decimals: 6 },
    { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", type: "WETH", symbol: "WETH", decimals: 18 },
    { address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", type: "WBTC", symbol: "WBTC", decimals: 8 },
  ],
  56: [
    { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", type: "USDC", symbol: "USDC", decimals: 18 },
    { address: "0x55d398326f99059fF775485246999027B3197955", type: "USDT", symbol: "USDT", decimals: 18 },
    { address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", type: "WETH", symbol: "WETH", decimals: 18 },
  ],
  130: [
    { address: "0x078D782b760474a361dDA0AF3839290b0EF57AD6", type: "USDC", symbol: "USDC", decimals: 6 },
    { address: "0x4200000000000000000000000000000000000006", type: "WETH", symbol: "WETH", decimals: 18 },
  ],
};

// ── Validation helpers ────────────────────────────────────────────────

/**
 * Find a bridgeable token on a chain by type (e.g. "USDC") or address.
 */
export function findBridgeableToken(
  chainId: number,
  symbolOrAddress: string,
): BridgeableToken | undefined {
  const tokens = CROSSCHAIN_TOKENS[chainId];
  if (!tokens) return undefined;

  const upper = symbolOrAddress.toUpperCase();
  // By symbol / type
  const bySymbol = tokens.find((t) => t.symbol === upper || t.type === upper);
  if (bySymbol) return bySymbol;

  // By address (case-insensitive)
  const lower = symbolOrAddress.toLowerCase();
  return tokens.find((t) => t.address.toLowerCase() === lower);
}

/**
 * Get the matching output token on the destination chain.
 * Enforces that input and output must be the same token type (USDC↔USDC, WETH↔WETH).
 */
export function getOutputToken(
  sourceChainId: number,
  destChainId: number,
  inputTokenAddress: Address,
): BridgeableToken | undefined {
  // Find the input token to know its type
  const sourceTokens = CROSSCHAIN_TOKENS[sourceChainId];
  if (!sourceTokens) return undefined;
  const inputToken = sourceTokens.find(
    (t) => t.address.toLowerCase() === inputTokenAddress.toLowerCase(),
  );
  if (!inputToken) return undefined;

  // Find the same type on the destination chain
  const destTokens = CROSSCHAIN_TOKENS[destChainId];
  if (!destTokens) return undefined;
  return destTokens.find((t) => t.type === inputToken.type);
}

/**
 * List chains that support a given token type.
 */
export function chainsForTokenType(tokenType: BridgeableTokenType): number[] {
  return Object.entries(CROSSCHAIN_TOKENS)
    .filter(([, tokens]) => tokens.some((t) => t.type === tokenType))
    .map(([chainId]) => Number(chainId));
}

/**
 * Get all supported destination chains from a source chain.
 * A chain can bridge to any other chain that shares at least one token type.
 */
export function getSupportedDestinations(sourceChainId: number): number[] {
  const sourceTypes = new Set(
    CROSSCHAIN_TOKENS[sourceChainId]?.map((t) => t.type) ?? [],
  );
  return Object.entries(CROSSCHAIN_TOKENS)
    .filter(
      ([chainId, tokens]) =>
        Number(chainId) !== sourceChainId &&
        tokens.some((t) => sourceTypes.has(t.type)),
    )
    .map(([chainId]) => Number(chainId));
}
