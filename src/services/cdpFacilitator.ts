/**
 * CDP Facilitator with a globally-pinned /supported document.
 *
 * WHY: CDP's upto supported response carries a `facilitatorAddress` that
 * rotates per /supported call. Each Cloudflare isolate fetches /supported at
 * initialize(), so isolates diverge — a payment signed against one isolate's
 * requirements fails validation in another ("No matching payment requirements"
 * / UnauthorizedFacilitator at settlement). Caching the FIRST response in KV
 * makes every isolate (and the billing signer) use the same facilitatorAddress
 * for the TTL window, while verification and settlement stay with the hosted
 * CDP facilitator.
 *
 * On settlement failures mentioning the facilitator, delete the KV key
 * (`x402:cdp-supported`) to re-pin globally.
 */

const SUPPORTED_CACHE_KEY = "x402:cdp-supported";
const SUPPORTED_TTL_SEC = 24 * 60 * 60;

interface SupportedLike {
  kinds: Array<Record<string, unknown>>;
  extensions?: string[];
  signers?: Record<string, string[]>;
}

/** Wrap a facilitator client's getSupported with a KV-backed global pin. */
export function pinSupportedInKv<T extends { getSupported(): Promise<SupportedLike> }>(
  kv: KVNamespace | undefined,
  client: T,
): T {
  if (!kv) return client; // no KV (unit tests) — pass through untouched
  const orig = client.getSupported.bind(client);
  (client as any).getSupported = async (): Promise<SupportedLike> => {
    const cached = await kv.get<SupportedLike>(SUPPORTED_CACHE_KEY, "json");
    if (cached && Array.isArray(cached.kinds) && cached.kinds.length > 0) {
      return cached;
    }
    const fresh = await orig();
    await kv.put(SUPPORTED_CACHE_KEY, JSON.stringify(fresh), {
      expirationTtl: SUPPORTED_TTL_SEC,
    });
    return fresh;
  };
  return client;
}

export { SUPPORTED_CACHE_KEY };
