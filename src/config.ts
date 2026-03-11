/**
 * Runtime configuration — chain and token resolution.
 *
 * Chain ID and vault address are provided per-request from the frontend,
 * not from environment variables.
 */

import {
  type Chain,
  base,
  mainnet,
  arbitrum,
  optimism,
  bsc,
  polygon,
  sepolia,
  baseSepolia,
} from "viem/chains";
import { defineChain } from "viem";

/** Unichain Mainnet — custom chain definition */
const unichain = defineChain({
  id: 130,
  name: "Unichain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.unichain.org"] } },
  blockExplorers: { default: { name: "Uniscan", url: "https://uniscan.xyz" } },
});

const chainMap: Record<number, Chain> = {
  1: mainnet,
  10: optimism,
  56: bsc,
  130: unichain,
  137: polygon,
  8453: base,
  42161: arbitrum,
  11155111: sepolia,
  84532: baseSepolia,
};

/** Supported mainnet chains (for the frontend chain selector) */
export const SUPPORTED_CHAINS = [
  { id: 1, name: "Ethereum", shortName: "ethereum" },
  { id: 8453, name: "Base", shortName: "base" },
  { id: 42161, name: "Arbitrum", shortName: "arbitrum" },
  { id: 10, name: "Optimism", shortName: "optimism" },
  { id: 137, name: "Polygon", shortName: "polygon" },
  { id: 56, name: "BNB Chain", shortName: "bsc" },
  { id: 130, name: "Unichain", shortName: "unichain" },
];

/** Testnet chains (only shown when testnet mode is on) */
export const TESTNET_CHAINS = [
  { id: 11155111, name: "Sepolia", shortName: "sepolia" },
];

export function getChain(chainId: number): Chain {
  const chain = chainMap[chainId];
  if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);
  return chain;
}

/** Resolve a chain name, shortName, or numeric ID string to a chain ID number.
 *  Accepts: "base", "Base", "8453", "arbitrum", "42161", etc. */
export function resolveChainId(chainArg: string): number {
  const num = Number(chainArg);
  if (!Number.isNaN(num) && chainMap[num]) return num;
  const allChains = [...SUPPORTED_CHAINS, ...TESTNET_CHAINS];
  const match = allChains.find(
    (c) =>
      c.name.toLowerCase() === chainArg.toLowerCase() ||
      c.shortName.toLowerCase() === chainArg.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `Unknown chain: ${chainArg}. Supported: ${allChains.map((c) => `${c.shortName} (${c.id})`).join(", ")}`,
    );
  }
  return match.id;
}

/**
 * Alchemy network slugs for each chain.
 * Chains not listed here use their default public RPC.
 */
const ALCHEMY_NETWORK: Record<number, string> = {
  1: "eth-mainnet",
  10: "opt-mainnet",
  137: "polygon-mainnet",
  8453: "base-mainnet",
  42161: "arb-mainnet",
  11155111: "eth-sepolia",
  84532: "base-sepolia",
};

/** Module-level Alchemy key removed — key is threaded from env.ALCHEMY_API_KEY
 *  through function parameters to avoid module-level mutable state. */

/** Get the best RPC URL for a chain (Alchemy if available, else public) */
export function getRpcUrl(chainId: number, alchemyKey?: string): string | undefined {
  if (alchemyKey) {
    const network = ALCHEMY_NETWORK[chainId];
    if (network) {
      return `https://${network}.g.alchemy.com/v2/${alchemyKey}`;
    }
  }
  return undefined; // viem will use the chain's default public RPC
}

/** Well-known token addresses per chain (extendable) */
export const TOKEN_MAP: Record<number, Record<string, `0x${string}`>> = {
  1: {
    // Ethereum Mainnet
    ETH: "0x0000000000000000000000000000000000000000",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  10: {
    // Optimism
    ETH: "0x0000000000000000000000000000000000000000",
    WETH: "0x4200000000000000000000000000000000000006",
  },
  56: {
    // BNB Chain (BSC)
    BNB: "0x0000000000000000000000000000000000000000",
    WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    ETH: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
    WETH: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
  },
  130: {
    // Unichain
    ETH: "0x0000000000000000000000000000000000000000",
    WETH: "0x4200000000000000000000000000000000000006",
  },
  137: {
    // Polygon
    POL: "0x0000000000000000000000000000000000000000",
    MATIC: "0x0000000000000000000000000000000000000000",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WPOL: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  },
  8453: {
    // Base Mainnet
    ETH: "0x0000000000000000000000000000000000000000",
    WETH: "0x4200000000000000000000000000000000000006",
  },
  42161: {
    // Arbitrum One
    ETH: "0x0000000000000000000000000000000000000000",
    WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "USDC.E": "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    WBTC: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    LINK: "0xf97f4df75e6c8e0ce7fec36ad7c4e12f3a1c33d8",
    UNI: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0",
  },
  11155111: {
    // Sepolia Testnet
    ETH: "0x0000000000000000000000000000000000000000",
    WETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  },
  84532: {
    // Base Sepolia
    ETH: "0x0000000000000000000000000000000000000000",
    WETH: "0x4200000000000000000000000000000000000006",
  },
};

import { resolveTokenBySymbol } from "./services/tokenResolver.js";

/**
 * Sanitise error messages before they reach the user or LLM.
 *
 * Strips:
 *  - Alchemy / RPC URLs that embed API keys
 *  - Any string that looks like a bare API key (32+ hex/base64 chars)
 *  - Full viem "HTTP request failed" stack (keeps only the Details line)
 */
export function sanitizeError(raw: string): string {
  // 1. Collapse the verbose viem "HTTP request failed" block into just the details
  const viemMatch = raw.match(/Details:\s*(.+?)(?:\n|$)/i);
  if (viemMatch) {
    // Still sanitise the extracted detail text (step 2 below)
    raw = viemMatch[1].trim();
  }

  // 2. Strip full RPC URLs (contain the API key in the path)
  raw = raw.replace(/https?:\/\/[^\s"')]+/g, "[RPC_URL]");

  // 3. Strip standalone API-key-like strings (32+ alnum chars WITHOUT a 0x prefix).
  //    Preserves Ethereum addresses (0x-prefixed) while redacting bare keys.
  //    Negative lookahead (?!0x) prevents matching words that start with "0x".
  raw = raw.replace(/\b(?!0x)[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]");

  return raw;
}

/**
 * Resolve a token symbol or address to a contract address.
 *
 * 1. If already a 0x address, return as-is
 * 2. Check static TOKEN_MAP (fast, no network call)
 * 3. Fall back to CoinGecko dynamic lookup
 */
export async function resolveTokenAddress(
  chainId: number,
  symbolOrAddress: string,
): Promise<`0x${string}`> {
  // If already an address, return as-is
  if (symbolOrAddress.startsWith("0x") && symbolOrAddress.length === 42) {
    return symbolOrAddress as `0x${string}`;
  }

  // Fast path: check static map
  const map = TOKEN_MAP[chainId];
  const staticAddr = map?.[symbolOrAddress.toUpperCase()];
  if (staticAddr) return staticAddr;

  // Dynamic lookup via CoinGecko
  return resolveTokenBySymbol(chainId, symbolOrAddress);
}
