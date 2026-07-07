/**
 * Generic RPC client factory.
 *
 * This is intentionally not tied to vault logic: every service that needs a
 * viem PublicClient (oracle reads, execution, NAV shield, GMX, delegation, …)
 * uses `getClient` from here. Keeping it separate prevents `vault.ts` from
 * becoming the kitchen-sink dependency of the whole app.
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { getChain, getRpcUrl } from "../config.js";
import { wrapFetchWithMetrics } from "./rpcMetrics.js";

/**
 * Allowed Origin header for Alchemy domain-restricted keys.
 * Cloudflare Workers don't send Origin by default, so Alchemy rejects
 * requests as "Unspecified". Setting this header fixes domain validation.
 */
export const ALCHEMY_ORIGIN = "https://trader.rigoblock.com";

/** Cache clients per chainId+key to avoid recreating */
const clientCache = new Map<string, PublicClient>();

export function getClient(chainId: number, alchemyKey?: string): PublicClient {
  const cacheKey = `${chainId}:${alchemyKey ? "alchemy" : "public"}`;
  const existing = clientCache.get(cacheKey);
  if (existing) return existing;
  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId, alchemyKey);
  const isAlchemy = rpcUrl?.includes("alchemy.com") ?? false;

  // Shared fetch wrapper for this client: metrics + Alchemy Origin header.
  const metricsFetch = wrapFetchWithMetrics(globalThis.fetch);
  const instrumentedFetch: typeof globalThis.fetch = async (input, init) => {
    const headers = isAlchemy
      ? { ...init?.headers, Origin: ALCHEMY_ORIGIN }
      : init?.headers;
    return metricsFetch(input, { ...init, headers });
  };

  const client = createPublicClient({
    chain,
    // Aggregate multiple readContract calls in the same microtask into one
    // Multicall3 eth_call. This is the single biggest "free" RPC reduction.
    batch: { multicall: true },
    transport: http(rpcUrl, {
      timeout: 10_000,
      fetchFn: instrumentedFetch,
    }),
  });
  clientCache.set(cacheKey, client);
  return client;
}
