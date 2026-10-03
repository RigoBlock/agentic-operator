/**
 * Universal Router version resolution for the Uniswap Trading API.
 *
 * Governance is upgrading the AUniswapRouter adapter mapping on the Rigoblock
 * Authority from the Universal Router 2.0-era deployments to the 2.1.2
 * deployments, chain by chain. The Uniswap Trading API encodes calldata
 * differently per router version (2.1.x added the `minHopPriceX36` argument
 * to the V2/V3 swap commands), and the vault adapter forwards our calldata to
 * whichever router the Authority currently maps — so the
 * `x-universal-router-version` header must follow the live on-chain mapping:
 *
 *   - quoting 2.1.2 calldata while the Authority still maps to a 2.0 adapter
 *     makes every V2/V3-routed swap revert on-chain, and
 *   - quoting 2.0 calldata after the upgrade reverts just the same.
 *
 * Ground truth is on-chain: `getApplicationAdapter(0x3593564c)` on the
 * Authority (same address on every chain). New adapter → "2.1.2", anything
 * else → "2.0". Results are cached briefly so a governance upgrade is picked
 * up within the TTL without an RPC call per request.
 */

import type { Address } from "viem";
import { AUTHORITY_ADDRESS, AUTHORITY_ABI } from "../abi/authority.js";
import { getRpcProvider } from "./rpcClient.js";

/** Selector every vault swap uses: execute(bytes,bytes[],uint256). */
const SWAP_SELECTOR = "0x3593564c";

export type UniversalRouterVersion = "2.0" | "2.1.2";

/**
 * Per-chain AUniswapRouter adapter addresses: the pre-upgrade deployment
 * (targets Universal Router 2.0) and the governance-upgrade deployment
 * (targets Universal Router 2.1.2).
 */
export const AUNISWAP_ROUTER_ADAPTERS: Record<number, { current: Address; upgraded: Address }> = {
  1:        { current: "0x8d89AC596804704Fff512DAe5cAC19319F3AB560", upgraded: "0x8E0F4Cb68e276e31cF48B33EddD40325f5a736D2" }, // Ethereum
  42161:    { current: "0x27A707296078C535b8eCabc3A5E9B5E26a9C2140", upgraded: "0x8ae37870fffB694a5e90F0caE79208D186009Ae9" }, // Arbitrum
  8453:     { current: "0x2b75aD5cB2fa53fF93D20F38b5f3264Fbd1A6f82", upgraded: "0x1A279E75FCAE3EBC12Db496BB015fA6614A1Af74" }, // Base
  56:       { current: "0x1dE6BA9EC7b30988af35F52A0Fce434409FB88A6", upgraded: "0x1984D57212125eBcd10D5B339b4fEf176E95e4EE" }, // BNB Chain
  10:       { current: "0xE1db51fa21EB0D185778d8c25dF33FA356f34730", upgraded: "0x3F978C999CF56F393150D1d21B47d3096b5606B4" }, // Optimism
  130:      { current: "0x767515c8A9d34dC66A5160bD58cd1d3EE03dAb00", upgraded: "0xA1aE17C6BF5cCECfb2efF519567B365bCA031Bdc" }, // Unichain
  137:      { current: "0xc4Eb59bf8606d96016af3664C5FDb08D67234078", upgraded: "0x1b2BCB8833bbB6a9f1eC6e41003E5daeb18a534a" }, // Polygon
  11155111: { current: "0x1CF61a7384C939B876A1F30129e6E18991b9cdD4", upgraded: "0x6e5aB204af73156F290927ae6936DDBB5A1dC3CD" }, // Sepolia
};

/** How long a resolution is trusted before re-reading the Authority. */
const CACHE_TTL_MS = 60_000;

const cache = new Map<number, { version: UniversalRouterVersion; expires: number }>();

/**
 * Resolve the router version the Uniswap Trading API must encode for, based
 * on which AUniswapRouter adapter the chain's Authority currently maps the
 * swap selector to.
 *
 * Fails safe toward "2.0" (the pre-upgrade, currently live encoding): a
 * misclassified "2.0" only matters once the API sunsets 2.0, while a
 * misclassified "2.1.2" reverts real swaps immediately. Chains without a
 * known adapter pair and unreadable Authority calls both take that default.
 */
export async function resolveUniversalRouterVersion(chainId: number): Promise<UniversalRouterVersion> {
  const cached = cache.get(chainId);
  if (cached && cached.expires > Date.now()) return cached.version;

  const adapters = AUNISWAP_ROUTER_ADAPTERS[chainId];
  if (!adapters) return "2.0";

  let version: UniversalRouterVersion = "2.0";
  try {
    const client = getRpcProvider(chainId);
    const adapter = (await client.readContract({
      address: AUTHORITY_ADDRESS,
      abi: AUTHORITY_ABI,
      functionName: "getApplicationAdapter",
      args: [SWAP_SELECTOR],
    })) as Address;

    if (adapter.toLowerCase() === adapters.upgraded.toLowerCase()) {
      version = "2.1.2";
    } else if (adapter.toLowerCase() !== adapters.current.toLowerCase()) {
      console.warn(
        `[routerVersion] Authority on chain ${chainId} maps ${SWAP_SELECTOR} to unexpected adapter ${adapter} ` +
        `(known: current ${adapters.current}, upgraded ${adapters.upgraded}) — defaulting to 2.0`,
      );
    }
  } catch (err) {
    console.warn(
      `[routerVersion] Failed to read Authority adapter mapping on chain ${chainId}: ` +
      `${err instanceof Error ? err.message : String(err)} — defaulting to 2.0`,
    );
  }

  cache.set(chainId, { version, expires: Date.now() + CACHE_TTL_MS });
  return version;
}
