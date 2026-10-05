/**
 * Universal Router version resolution for the Uniswap Trading API.
 *
 * Governance is upgrading the AUniswapRouter adapter mapping on the Rigoblock
 * Authority from the Universal Router 2.0-era deployments to adapters built
 * against Universal Router 2.1.2. The Uniswap Trading API encodes calldata
 * differently per router version (2.1.x added the `minHopPriceX36` argument
 * to the V2/V3 swap commands), and the vault adapter forwards our calldata to
 * whichever router its adapter calls — so the `x-universal-router-version`
 * header must follow the live on-chain mapping:
 *
 *   - quoting 2.1.2 calldata while the Authority still maps to a 2.0 adapter
 *     makes every V2/V3-routed swap revert on-chain, and
 *   - quoting 2.0 calldata after the upgrade reverts just the same.
 *
 * Protocol invariant (Rigoblock governance): the adapter deployed on each
 * chain today is the only UR 2.0-based one; every future adapter — including
 * bugfix redeploys to fresh addresses — is built against UR 2.1.2. So the
 * version is decided by a single comparison against the known 2.0 adapter:
 * anything else means 2.1.2, and no per-upgrade address table is needed.
 *
 * Ground truth is on-chain: `getApplicationAdapter(0x3593564c)` on the
 * Authority (same address on every chain). Results are cached briefly so a
 * governance upgrade is picked up within the TTL without an RPC call per
 * request.
 */

import type { Address } from "viem";
import { AUTHORITY_ADDRESS, AUTHORITY_ABI } from "../abi/authority.js";
import { getRpcProvider } from "./rpcClient.js";

/** Selector every vault swap uses: execute(bytes,bytes[],uint256). */
const SWAP_SELECTOR = "0x3593564c";

/** Unmapped selector — no adapter on this chain, so no router to encode for. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type UniversalRouterVersion = "2.0" | "2.1.2";

/**
 * The AUniswapRouter adapter deployed on each chain before the UR 2.1.2
 * upgrade — the only UR 2.0-based adapter. Any other adapter the Authority
 * maps the swap selector to speaks UR 2.1.2.
 */
export const UR2_ADAPTERS: Record<number, Address> = {
  1:        "0x8d89AC596804704Fff512DAe5cAC19319F3AB560", // Ethereum
  42161:    "0x27A707296078C535b8eCabc3A5E9B5E26a9C2140", // Arbitrum
  8453:     "0x2b75aD5cB2fa53fF93D20F38b5f3264Fbd1A6f82", // Base
  56:       "0x1dE6BA9EC7b30988af35F52A0Fce434409FB88A6", // BNB Chain
  10:       "0xE1db51fa21EB0D185778d8c25dF33FA356f34730", // Optimism
  130:      "0x767515c8A9d34dC66A5160bD58cd1d3EE03dAb00", // Unichain
  137:      "0xc4Eb59bf8606d96016af3664C5FDb08D67234078", // Polygon
  11155111: "0x1CF61a7384C939B876A1F30129e6E18991b9cdD4", // Sepolia
};

/** How long a resolution is trusted before re-reading the Authority. */
const CACHE_TTL_MS = 60_000;

const cache = new Map<number, { version: UniversalRouterVersion; expires: number }>();

/**
 * Resolve the router version the Uniswap Trading API must encode for, based
 * on which adapter the chain's Authority currently maps the swap selector to:
 * the known pre-upgrade adapter → "2.0", any other adapter → "2.1.2".
 *
 * Fails safe toward "2.0" (the pre-upgrade encoding): a misclassified "2.0"
 * only matters once the API sunsets 2.0, while a misclassified "2.1.2"
 * reverts real swaps immediately. Chains without a known UR 2.0 adapter and
 * unreadable Authority calls both take that default.
 */
export async function resolveUniversalRouterVersion(chainId: number): Promise<UniversalRouterVersion> {
  const cached = cache.get(chainId);
  if (cached && cached.expires > Date.now()) return cached.version;

  const ur2Adapter = UR2_ADAPTERS[chainId];
  if (!ur2Adapter) return "2.0";

  let version: UniversalRouterVersion = "2.0";
  try {
    const client = getRpcProvider(chainId);
    const adapter = (await client.readContract({
      address: AUTHORITY_ADDRESS,
      abi: AUTHORITY_ABI,
      functionName: "getApplicationAdapter",
      args: [SWAP_SELECTOR],
    })) as Address;

    if (adapter.toLowerCase() === ZERO_ADDRESS) {
      // Selector unmapped on this chain — no router will execute the swap.
      // Keep the 2.0 default; the vault fallback reverts regardless.
    } else if (adapter.toLowerCase() !== ur2Adapter.toLowerCase()) {
      // Any adapter that is not the known UR 2.0 one speaks UR 2.1.2 —
      // the governance upgrade and all future redeploys.
      version = "2.1.2";
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
