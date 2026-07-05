/**
 * Dynamic token resolution via CoinGecko API.
 *
 * Resolves arbitrary token symbols (e.g., "GRG", "AAVE", "PEPE") to
 * contract addresses on any supported chain. The static TOKEN_MAP in
 * config.ts handles only native tokens (ETH, BNB, POL) and stables;
 * this service handles everything else dynamically.
 *
 * Caching strategy (3 layers):
 *   1. In-memory cache (per isolate, fastest)
 *   2. KV persistent cache (Cloudflare KV, 30 day TTL)
 *   3. CoinGecko API (search → coin detail)
 *
 * Token addresses never change, so aggressive caching is safe.
 */

const COINGECKO_API = "https://api.coingecko.com/api/v3";

/** Map chain IDs to CoinGecko platform identifiers */
const CHAIN_TO_PLATFORM: Record<number, string> = {
  1: "ethereum",
  10: "optimistic-ethereum",
  56: "binance-smart-chain",
  130: "unichain",
  137: "polygon-pos",
  8453: "base",
  42161: "arbitrum-one",
  11155111: "", // testnet — no CoinGecko data
};

/** Reverse lookup used for error messages */
const PLATFORM_TO_CHAIN_NAME: Record<string, string> = {
  ethereum: "Ethereum",
  "optimistic-ethereum": "Optimism",
  "binance-smart-chain": "BSC",
  unichain: "Unichain",
  "polygon-pos": "Polygon",
  base: "Base",
  "arbitrum-one": "Arbitrum",
};

/** In-memory cache: `SYMBOL:chainId` → address */
const memoryCache = new Map<string, `0x${string}`>();

/** Module-level KV reference — set via initTokenResolver() */
let _kv: KVNamespace | null = null;

const KV_PREFIX = "token:";
const KV_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Call once per request to enable KV persistent caching */
export function initTokenResolver(kv: KVNamespace): void {
  _kv = kv;
}

/** Standard headers for CoinGecko (prevents 403 from serverless IPs) */
const CG_HEADERS: Record<string, string> = {
  "User-Agent": "RigoblockOperator/1.0",
  Accept: "application/json",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry fetch helper for transient CoinGecko failures (429 / 5xx / network).
 * Backs off linearly with jitter to avoid thundering herd.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  { retries = 3, baseDelay = 500 }: { retries?: number; baseDelay?: number } = {},
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;

      // Retry on rate limits and server errors; do not retry client errors
      if (res.status === 429 || res.status >= 500) {
        const text = await res.text().catch(() => "");
        lastError = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      } else {
        // 4xx errors are final
        return res;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < retries) {
      const jitter = Math.floor(Math.random() * 200);
      await sleep(baseDelay * (attempt + 1) + jitter);
    }
  }

  throw new Error(
    `CoinGecko request failed after ${retries + 1} attempts: ${lastError?.message || "unknown"}`,
  );
}

/**
 * Resolve a token symbol to a contract address on the given chain.
 * Uses 3-layer caching: memory → KV → CoinGecko API.
 *
 * @throws if the token is not found or has no contract on this chain
 */
export async function resolveTokenBySymbol(
  chainId: number,
  symbol: string,
): Promise<`0x${string}`> {
  const upper = symbol.toUpperCase();
  const cacheKey = `${upper}:${chainId}`;

  // Layer 1: in-memory cache
  const memCached = memoryCache.get(cacheKey);
  if (memCached) return memCached;

  // Layer 2: KV persistent cache
  if (_kv) {
    try {
      const kvAddr = await _kv.get(`${KV_PREFIX}${cacheKey}`);
      if (kvAddr && kvAddr.startsWith("0x")) {
        const addr = kvAddr as `0x${string}`;
        memoryCache.set(cacheKey, addr);
        return addr;
      }
    } catch {
      // KV read failed — fall through to CoinGecko
    }
  }

  const platform = CHAIN_TO_PLATFORM[chainId];
  if (platform === undefined || platform === "") {
    throw new Error(
      `Dynamic token resolution not available for chain ${chainId}. ` +
        `Please provide the contract address for "${symbol}".`,
    );
  }

  // Layer 3: CoinGecko API
  const searchRes = await fetchWithRetry(
    `${COINGECKO_API}/search?query=${encodeURIComponent(symbol)}`,
    { headers: CG_HEADERS },
    { retries: 3, baseDelay: 500 },
  );
  if (!searchRes.ok) {
    const status = searchRes.status;
    console.error(
      `[tokenResolver] CoinGecko search failed (${status}):`,
      await searchRes.text().catch(() => ""),
    );
    throw new Error(
      `Token lookup failed (CoinGecko ${status}). ` +
        `Please provide the contract address for "${symbol}".`,
    );
  }
  const searchData = (await searchRes.json()) as {
    coins?: Array<{
      id: string;
      symbol: string;
      name: string;
      market_cap_rank: number | null;
    }>;
  };

  const coins = searchData.coins || [];

  // Find exact symbol match — prefer by market cap rank (lower = bigger)
  const exactMatches = coins.filter(
    (c) => c.symbol?.toUpperCase() === upper,
  );
  if (exactMatches.length === 0) {
    throw new Error(
      `Token "${symbol}" not found on CoinGecko. Please provide the contract address.`,
    );
  }

  // Sort by market cap rank (null = unranked, push to end)
  exactMatches.sort((a, b) => {
    if (a.market_cap_rank === null && b.market_cap_rank === null) return 0;
    if (a.market_cap_rank === null) return 1;
    if (b.market_cap_rank === null) return -1;
    return a.market_cap_rank - b.market_cap_rank;
  });

  // Get coin details and collect ALL candidates with contracts on this chain
  const candidates: Array<{
    name: string;
    address: `0x${string}`;
    rank: number | null;
  }> = [];

  let fetchFailures = 0;
  const checkedDetails: Array<{
    id: string;
    name: string;
    platforms?: Record<string, string>;
    fetchFailed: boolean;
  }> = [];

  for (const match of exactMatches) {
    try {
      const coinRes = await fetchWithRetry(
        `${COINGECKO_API}/coins/${match.id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
        { headers: CG_HEADERS },
        { retries: 3, baseDelay: 750 },
      );
      if (!coinRes.ok) {
        fetchFailures++;
        checkedDetails.push({
          id: match.id,
          name: match.name,
          fetchFailed: true,
        });
        continue;
      }

      const coinData = (await coinRes.json()) as {
        platforms?: Record<string, string>;
      };

      checkedDetails.push({
        id: match.id,
        name: match.name,
        platforms: coinData.platforms || {},
        fetchFailed: false,
      });

      const address = coinData.platforms?.[platform];
      if (address && address.startsWith("0x")) {
        candidates.push({
          name: match.name,
          address: address as `0x${string}`,
          rank: match.market_cap_rank,
        });
      }
    } catch (err) {
      fetchFailures++;
      console.error(
        `[tokenResolver] CoinGecko coin/${match.id} failed:`,
        err instanceof Error ? err.message : String(err),
      );
      checkedDetails.push({
        id: match.id,
        name: match.name,
        fetchFailed: true,
      });
    }
  }

  if (candidates.length === 0) {
    const topMatch = exactMatches[0];

    // If every detail fetch failed, say so instead of pretending the token
    // does not exist on this chain.
    if (fetchFailures === exactMatches.length) {
      throw new Error(
        `Token "${symbol}" (${topMatch.id}) was found on CoinGecko, but its contract details could not be retrieved. ` +
          `This is usually a temporary rate-limit from CoinGecko. Please retry shortly or provide the contract address.`,
      );
    }

    // Otherwise, the token genuinely has no contract on this chain. List the
    // chains where the top match is available so the user can switch chain or
    // paste an address.
    const topDetails = checkedDetails.find((d) => d.id === topMatch.id);
    const availableChains = topDetails?.platforms
      ? Object.keys(topDetails.platforms)
          .map((p) => PLATFORM_TO_CHAIN_NAME[p] || p)
          .filter(Boolean)
          .join(", ")
      : "";

    const hint = availableChains
      ? ` It is available on: ${availableChains}.`
      : "";

    throw new Error(
      `Token "${symbol}" (${topMatch.id}) found on CoinGecko but has no contract on chain ${chainId}.${hint} ` +
        `Try a different chain or provide the contract address.`,
    );
  }

  if (candidates.length === 1) {
    const addr = candidates[0].address;
    memoryCache.set(cacheKey, addr);
    if (_kv) {
      _kv
        .put(`${KV_PREFIX}${cacheKey}`, addr, { expirationTtl: KV_TTL_SECONDS })
        .catch(() => {});
    }
    return addr;
  }

  // Multiple tokens with the same symbol on this chain — ask user to choose
  const list = candidates
    .map(
      (c, i) =>
        `${i + 1}. ${c.name}${c.rank ? ` (#${c.rank})` : ""} — ${c.address}`,
    )
    .join("\n");
  throw new Error(
    `Multiple tokens match "${symbol}" on this chain:\n${list}\nPlease specify which one by name or contract address.`,
  );
}
