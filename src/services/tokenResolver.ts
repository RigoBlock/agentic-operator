/**
 * Dynamic token resolution with KV-first registry and CoinGecko fallback.
 *
 * Resolution order:
 *   1. Static TOKEN_MAP in config.ts (native tokens + stables)
 *   2. In-memory cache
 *   3. KV registry of token candidates per chain+symbol
 *   4. CoinGecko API search (short timeout; treated as fallback)
 *
 * When CoinGecko returns multiple tokens with the same symbol, the user is
 * asked to disambiguate. Resolved candidates are stored in KV so the slow
 * external lookup is skipped next time.
 */

import type { Address } from "viem";

const COINGECKO_API = "https://api.coingecko.com/api/v3";

/** CoinGecko platform id per chain. Empty string means "no data". */
const CHAIN_TO_PLATFORM: Record<number, string> = {
  1: "ethereum",
  10: "optimistic-ethereum",
  56: "binance-smart-chain",
  130: "unichain",
  137: "polygon-pos",
  8453: "base",
  42161: "arbitrum-one",
  11155111: "",
};

const PLATFORM_TO_CHAIN_NAME: Record<string, string> = {
  ethereum: "Ethereum",
  "optimistic-ethereum": "Optimism",
  "binance-smart-chain": "BSC",
  unichain: "Unichain",
  "polygon-pos": "Polygon",
  base: "Base",
  "arbitrum-one": "Arbitrum",
};

export interface TokenCandidate {
  address: Address;
  name: string;
  symbol: string;
  chainId: number;
  source: "coingecko" | "verified";
}

/** In-memory cache: `${chainId}:${symbol}` → candidates */
const memoryCache = new Map<string, TokenCandidate[]>();

/** Module-level KV reference — set via initTokenResolver() */
let _kv: KVNamespace | null = null;

const KV_PREFIX = "tokens:";
const KV_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** How long we wait for CoinGecko before giving up and asking the user. */
const COINGECKO_TIMEOUT_MS = 2_500;

/** Max number of ambiguous CoinGecko matches we fetch details for. */
const MAX_AMBIGUOUS_LOOKUPS = 5;

const CG_HEADERS: Record<string, string> = {
  "User-Agent": "RigoblockOperator/1.0",
  Accept: "application/json",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Call once per request to enable KV persistent caching. */
export function initTokenResolver(kv: KVNamespace): void {
  _kv = kv;
}

/** Clear the in-memory cache. Useful in tests. */
export function clearTokenResolverCache(): void {
  memoryCache.clear();
}

function getMemoryCacheKey(chainId: number, symbol: string): string {
  return `${chainId}:${symbol.toUpperCase()}`;
}

function getKvKey(chainId: number, symbol: string): string {
  return `${KV_PREFIX}${chainId}:${symbol.toUpperCase()}`;
}

async function getKvCandidates(
  chainId: number,
  symbol: string,
): Promise<TokenCandidate[] | null> {
  if (!_kv) return null;
  try {
    const raw = await _kv.get(getKvKey(chainId, symbol));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TokenCandidate[];
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((c) => c && c.address && c.address.startsWith("0x"));
  } catch {
    return null;
  }
}

async function setKvCandidates(
  chainId: number,
  symbol: string,
  candidates: TokenCandidate[],
): Promise<void> {
  if (!_kv || candidates.length === 0) return;
  try {
    await _kv.put(getKvKey(chainId, symbol), JSON.stringify(candidates), {
      expirationTtl: KV_TTL_SECONDS,
    });
  } catch {
    // Non-fatal: the in-memory cache still helps.
  }
}

function disambiguationError(
  symbol: string,
  chainId: number,
  candidates: TokenCandidate[],
): Error {
  const list = candidates
    .map((c) => `• ${c.name} — ${c.address}`)
    .join("\n");
  return new Error(
    `Multiple tokens match "${symbol}" on chain ${chainId}. Please specify which one by name or contract address:\n${list}`,
  );
}

function isValidEvmAddress(value: string): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

async function storeVerifiedCandidate(
  chainId: number,
  symbol: string,
  address: Address,
  name: string,
): Promise<void> {
  const upper = symbol.toUpperCase();
  const candidate: TokenCandidate = {
    address,
    name: name || upper,
    symbol: upper,
    chainId,
    source: "verified",
  };
  const cacheKey = getMemoryCacheKey(chainId, upper);
  memoryCache.set(cacheKey, [candidate]);
  await setKvCandidates(chainId, upper, [candidate]);
}

function pickSingleOrDisambiguate(
  symbol: string,
  chainId: number,
  candidates: TokenCandidate[],
): Address {
  if (candidates.length === 1) return candidates[0].address;
  throw disambiguationError(symbol, chainId, candidates);
}

interface CoinGeckoSearchCoin {
  id: string;
  symbol: string;
  name: string;
  market_cap_rank: number | null;
}

interface CoinGeckoCoinDetail {
  id?: string;
  name?: string;
  symbol?: string;
  platforms?: Record<string, string>;
}

async function fetchCoinGecko(
  path: string,
  { timeoutMs = COINGECKO_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<Response> {
  const url = `${COINGECKO_API}${path}`;
  const res = await fetch(url, {
    headers: CG_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

async function searchCoinGecko(
  symbol: string,
): Promise<CoinGeckoSearchCoin[]> {
  const res = await fetchCoinGecko(
    `/search?query=${encodeURIComponent(symbol)}`,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CoinGecko search failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { coins?: CoinGeckoSearchCoin[] };
  return data.coins || [];
}

async function fetchCoinGeckoCoinDetail(
  id: string,
): Promise<CoinGeckoCoinDetail> {
  const res = await fetchCoinGecko(
    `/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CoinGecko coin/${id} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as CoinGeckoCoinDetail;
}

async function fetchCoinGeckoContractInfo(
  platform: string,
  address: string,
): Promise<CoinGeckoCoinDetail | null> {
  const res = await fetchCoinGecko(`/coins/${platform}/contract/${address.toLowerCase()}`);
  if (!res.ok) return null;
  try {
    return (await res.json()) as CoinGeckoCoinDetail;
  } catch {
    return null;
  }
}

/**
 * Verify a user-supplied address or name against CoinGecko and, if confirmed,
 * store the mapping in KV.
 *
 * This is the ONLY safe way to write to the token registry from a user-facing
 * flow: the code checks CoinGecko autonomously, so the LLM/agent cannot prompt-
 * inject an arbitrary address into the cache. Address inputs are length/format
 * validated before any external call.
 */
export async function verifyAndRegisterToken(
  chainId: number,
  symbol: string,
  addressOrName: string,
): Promise<Address> {
  const upper = symbol.toUpperCase();

  if (!addressOrName || addressOrName.length > 200) {
    throw new Error("Invalid token identifier. Provide a valid contract address or token name.");
  }

  const platform = CHAIN_TO_PLATFORM[chainId];
  if (!platform) {
    throw new Error(
      `Dynamic token resolution not available for chain ${chainId}. Please provide the contract address directly.`,
    );
  }

  // If it starts with "0x" it must be a valid 20-byte address; otherwise treat as a name.
  if (addressOrName.startsWith("0x")) {
    if (!isValidEvmAddress(addressOrName)) {
      throw new Error("Invalid token identifier. Provide a valid contract address (0x + 40 hex chars) or token name.");
    }
    const address = addressOrName.toLowerCase() as `0x${string}`;
    const coin = await fetchCoinGeckoContractInfo(platform, address);
    if (!coin || coin.symbol?.toUpperCase() !== upper) {
      throw new Error(
        `CoinGecko does not recognize ${addressOrName} as ${symbol} on chain ${chainId}. ` +
          `Please check the address or provide the token name instead.`,
      );
    }
    const verifiedAddress = (coin.platforms?.[platform] || address) as Address;
    await storeVerifiedCandidate(chainId, upper, verifiedAddress, coin.name || upper);
    return verifiedAddress;
  }

  // Name path: search CoinGecko for the symbol, then pick the one whose name matches.
  const nameQuery = addressOrName.toLowerCase();
  let coins: CoinGeckoSearchCoin[];
  try {
    coins = await searchCoinGecko(symbol);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Token verification for "${symbol}" is temporarily unavailable (CoinGecko slow or rate-limited): ${msg}`,
    );
  }

  const exactMatches = coins.filter((c) => c.symbol?.toUpperCase() === upper);
  if (exactMatches.length === 0) {
    throw new Error(`Token "${symbol}" not found on CoinGecko. Please provide the contract address.`);
  }

  const nameMatches = exactMatches.filter((c) => c.name.toLowerCase().includes(nameQuery));
  if (nameMatches.length === 0) {
    throw new Error(
      `No token named "${addressOrName}" matches "${symbol}" on CoinGecko. ` +
        `Please provide the exact contract address instead.`,
    );
  }
  if (nameMatches.length > 1) {
    const candidates: TokenCandidate[] = [];
    for (const match of nameMatches.slice(0, MAX_AMBIGUOUS_LOOKUPS)) {
      try {
        const detail = await fetchCoinGeckoCoinDetail(match.id);
        const addr = detail.platforms?.[platform];
        if (addr && isValidEvmAddress(addr)) {
          candidates.push({
            address: addr as Address,
            name: detail.name || match.name,
            symbol: upper,
            chainId,
            source: "coingecko",
          });
        }
      } catch {
        // skip
      }
    }
    throw disambiguationError(symbol, chainId, candidates);
  }

  const detail = await fetchCoinGeckoCoinDetail(nameMatches[0].id);
  const verifiedAddress = detail.platforms?.[platform];
  if (!verifiedAddress || !isValidEvmAddress(verifiedAddress)) {
    throw new Error(
      `"${nameMatches[0].name}" (${symbol}) is listed on CoinGecko but has no verified contract on chain ${chainId}.`,
    );
  }

  await storeVerifiedCandidate(
    chainId,
    upper,
    verifiedAddress as Address,
    detail.name || nameMatches[0].name,
  );
  return verifiedAddress as Address;
}

/**
 * Resolve a token symbol to a contract address on the given chain.
 *
 * Uses the local registry first, then CoinGecko as a fallback. When multiple
 * tokens share the same symbol, throws a disambiguation error listing the
 * candidates so the user (or LLM) can pick one.
 */
export async function resolveTokenBySymbol(
  chainId: number,
  symbol: string,
): Promise<Address> {
  const upper = symbol.toUpperCase();
  const cacheKey = getMemoryCacheKey(chainId, upper);

  // 1. In-memory cache
  const memCached = memoryCache.get(cacheKey);
  if (memCached) {
    return pickSingleOrDisambiguate(symbol, chainId, memCached);
  }

  // 2. KV registry
  const kvCandidates = await getKvCandidates(chainId, upper);
  if (kvCandidates && kvCandidates.length > 0) {
    memoryCache.set(cacheKey, kvCandidates);
    return pickSingleOrDisambiguate(symbol, chainId, kvCandidates);
  }

  const platform = CHAIN_TO_PLATFORM[chainId];
  if (platform === undefined || platform === "") {
    throw new Error(
      `Dynamic token resolution not available for chain ${chainId}. ` +
        `Please provide the contract address for "${symbol}".`,
    );
  }

  // 3. CoinGecko fallback
  let coins: CoinGeckoSearchCoin[];
  try {
    coins = await searchCoinGecko(symbol);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tokenResolver] CoinGecko search timeout/failure for ${symbol}:`, msg);
    throw new Error(
      `Token lookup for "${symbol}" is temporarily unavailable (CoinGecko slow or rate-limited). ` +
        `Please provide the contract address or retry shortly.`,
    );
  }

  const exactMatches = coins.filter(
    (c) => c.symbol?.toUpperCase() === upper,
  );
  if (exactMatches.length === 0) {
    throw new Error(
      `Token "${symbol}" not found on CoinGecko. Please provide the contract address.`,
    );
  }

  exactMatches.sort((a, b) => {
    if (a.market_cap_rank === null && b.market_cap_rank === null) return 0;
    if (a.market_cap_rank === null) return 1;
    if (b.market_cap_rank === null) return -1;
    return a.market_cap_rank - b.market_cap_rank;
  });

  // Fetch details for the top matches, stopping as soon as we can resolve.
  const candidates: TokenCandidate[] = [];
  const toCheck = exactMatches.slice(0, MAX_AMBIGUOUS_LOOKUPS);

  for (const match of toCheck) {
    try {
      const detail = await fetchCoinGeckoCoinDetail(match.id);
      const address = detail.platforms?.[platform];
      if (address && address.startsWith("0x")) {
        candidates.push({
          address: address as Address,
          name: detail.name || match.name,
          symbol: upper,
          chainId,
          source: "coingecko",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[tokenResolver] CoinGecko coin/${match.id} failed:`, msg);
    }
  }

  if (candidates.length > 0) {
    // Persist what we found so we never hit CoinGecko again for this symbol.
    memoryCache.set(cacheKey, candidates);
    await setKvCandidates(chainId, upper, candidates);

    if (candidates.length === 1) {
      return candidates[0].address;
    }
    throw disambiguationError(symbol, chainId, candidates);
  }

  // No contract on this chain. Tell the user where the top match exists.
  const topMatch = exactMatches[0];
  let availableChains = "";
  try {
    const topDetail = await fetchCoinGeckoCoinDetail(topMatch.id);
    availableChains = topDetail.platforms
      ? Object.keys(topDetail.platforms)
          .map((p) => PLATFORM_TO_CHAIN_NAME[p] || p)
          .filter(Boolean)
          .join(", ")
      : "";
  } catch {
    // ignore
  }

  const hint = availableChains ? ` It is available on: ${availableChains}.` : "";
  throw new Error(
    `Token "${symbol}" (${topMatch.name}) found on CoinGecko but has no contract on chain ${chainId}.${hint} ` +
      `Try a different chain or provide the contract address.`,
  );
}
