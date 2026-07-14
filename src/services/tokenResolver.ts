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

export class TokenResolutionError extends Error {
  /** True when the user needs to supply more info (name/address). */
  needsUserInput: boolean;
  /** Human prompt telling the user what to provide. */
  hint: string;
  /** Candidate tokens when the symbol is ambiguous. */
  candidates?: TokenCandidate[];

  constructor(
    message: string,
    opts: { hint: string; candidates?: TokenCandidate[] },
  ) {
    super(message);
    this.name = "TokenResolutionError";
    this.needsUserInput = true;
    this.hint = opts.hint;
    this.candidates = opts.candidates;
  }
}

const COINGECKO_API = "https://api.coingecko.com/api/v3";

/** Optional CoinGecko demo API key. Set via initTokenResolver().
 *  Cloudflare Workers appear to require a demo key even for endpoints that are
 *  keyless from localhost. When unset, no auth header is sent. */
let _apiKey: string | null = null;

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

/** In-flight resolve promises so concurrent calls for the same chain+symbol
 *  share one network request instead of hammering CoinGecko. */
const inFlight = new Map<string, Promise<Address>>();

const KV_PREFIX = "tokens:";
const KV_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** How long we wait for CoinGecko before giving up and asking the user. */
const COINGECKO_TIMEOUT_MS = 5_000;

/** Retry transient network/timeout failures once after a short pause.
 *  Does NOT retry explicit rate-limit / access-denied responses. */
async function withCoinGeckoRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CoinGeckoRateLimitError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tokenResolver] ${label} failed, retrying once:`, msg);
    await sleep(300);
    return fn();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thrown when CoinGecko explicitly rate-limits us. Not retried. */
class CoinGeckoRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoinGeckoRateLimitError";
  }
}

function getCoinGeckoHeaders(): Record<string, string> | undefined {
  if (!_apiKey) return undefined;
  return { "x-cg-demo-api-key": _apiKey };
}

/** Call once per request to enable KV persistent caching. */
export function initTokenResolver(kv: KVNamespace, apiKey?: string): void {
  _kv = kv;
  _apiKey = apiKey ?? null;
}

/** Clear the in-memory cache. Useful in tests. */
export function clearTokenResolverCache(): void {
  memoryCache.clear();
  inFlight.clear();
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
): TokenResolutionError {
  const list = candidates
    .map((c) => `• ${c.name} — ${c.address}`)
    .join("\n");
  return new TokenResolutionError(
    `Multiple tokens match "${symbol}" on chain ${chainId}.`,
    {
      hint: "Please tell me which one you mean by providing the full token name or contract address.",
      candidates,
    },
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
  asset_platform_id?: string;
  contract_address?: string;
  platforms?: Record<string, string>;
}

function getChainAddress(detail: CoinGeckoCoinDetail, platform: string): string | undefined {
  const fromPlatforms = detail.platforms?.[platform];
  if (fromPlatforms) return fromPlatforms;
  if (detail.asset_platform_id === platform && detail.contract_address) {
    return detail.contract_address;
  }
  return undefined;
}

async function fetchCoinGecko(
  path: string,
  { timeoutMs = COINGECKO_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<Response> {
  const url = `${COINGECKO_API}${path}`;
  const headers = getCoinGeckoHeaders();
  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`CoinGecko fetch failed for ${url}: ${msg}`);
  }
  if (!res.ok) {
    // Clone before reading so the caller can still consume the original body.
    const text = await res.clone().text().catch(() => "");
    console.warn(
      `[tokenResolver] CoinGecko HTTP ${res.status} for ${url}: ${text.slice(0, 300)}`,
    );
    if (res.status === 429 || res.status === 403) {
      throw new CoinGeckoRateLimitError(
        `CoinGecko rate-limited or blocked this IP (${res.status}) at ${url}. ` +
          `Please provide the token contract address or exact token name.`,
      );
    }
    throw new Error(`CoinGecko HTTP ${res.status} at ${url}: ${text.slice(0, 200)}`);
  }
  return res;
}

async function searchCoinGecko(
  symbol: string,
): Promise<CoinGeckoSearchCoin[]> {
  const res = await withCoinGeckoRetry(
    () => fetchCoinGecko(`/search?query=${encodeURIComponent(symbol)}`),
    "CoinGecko search",
  );
  const data = (await res.json()) as { coins?: CoinGeckoSearchCoin[] };
  console.log(`[tokenResolver] CoinGecko search for "${symbol}" returned ${data.coins?.length || 0} coins`);
  return data.coins || [];
}

async function fetchCoinGeckoCoinDetail(
  id: string,
): Promise<CoinGeckoCoinDetail> {
  const res = await withCoinGeckoRetry(
    () =>
      fetchCoinGecko(
        `/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
      ),
    `CoinGecko coin/${id}`,
  );
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
    throw new TokenResolutionError(
      "Invalid token identifier.",
      { hint: "Provide a valid contract address (0x + 40 hex chars) or exact token name." },
    );
  }

  const platform = CHAIN_TO_PLATFORM[chainId];
  if (!platform) {
    throw new TokenResolutionError(
      `Dynamic token resolution is not available for chain ${chainId}.`,
      { hint: `Please provide the contract address for "${symbol}".` },
    );
  }

  // If it starts with "0x" it must be a valid 20-byte address; otherwise treat as a name.
  if (addressOrName.startsWith("0x")) {
    if (!isValidEvmAddress(addressOrName)) {
      throw new TokenResolutionError(
        "Invalid contract address.",
        { hint: "A contract address must be 0x followed by 40 hex characters." },
      );
    }
    const address = addressOrName.toLowerCase() as `0x${string}`;
    const coin = await fetchCoinGeckoContractInfo(platform, address);
    if (!coin || coin.symbol?.toUpperCase() !== upper) {
      throw new TokenResolutionError(
        `CoinGecko does not recognize ${addressOrName} as ${symbol} on chain ${chainId}.`,
        { hint: "Please check the address or provide the exact token name instead." },
      );
    }
    const verifiedAddress = (getChainAddress(coin, platform) || address) as Address;
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
    throw new TokenResolutionError(
      `Token "${symbol}" was not found on CoinGecko.`,
      { hint: `Please provide the contract address or exact token name for "${symbol}".` },
    );
  }

  const nameMatches = exactMatches.filter((c) => c.name.toLowerCase().includes(nameQuery));
  if (nameMatches.length === 0) {
    throw new TokenResolutionError(
      `No token named "${addressOrName}" matches "${symbol}" on CoinGecko.`,
      { hint: "Please provide the exact contract address instead." },
    );
  }
  if (nameMatches.length > 1) {
    const candidates: TokenCandidate[] = [];
    for (const match of nameMatches) {
      try {
        const detail = await fetchCoinGeckoCoinDetail(match.id);
        const addr = getChainAddress(detail, platform);
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
  const verifiedAddress = getChainAddress(detail, platform);
  if (!verifiedAddress || !isValidEvmAddress(verifiedAddress)) {
    throw new TokenResolutionError(
      `"${nameMatches[0].name}" (${symbol}) is listed on CoinGecko but has no verified contract on chain ${chainId}.`,
      { hint: "Try a different chain or provide the contract address." },
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
    throw new TokenResolutionError(
      `Dynamic token resolution is not available for chain ${chainId}.`,
      { hint: `Please provide the contract address for "${symbol}".` },
    );
  }

  // 3. CoinGecko fallback — dedupe concurrent lookups for the same chain+symbol
  const flightKey = `${chainId}:${upper}`;
  const existing = inFlight.get(flightKey);
  if (existing) return existing;

  const promise = resolveTokenBySymbolNetwork(chainId, symbol, upper, platform).finally(() => {
    inFlight.delete(flightKey);
  });
  inFlight.set(flightKey, promise);
  return promise;
}

async function resolveTokenBySymbolNetwork(
  chainId: number,
  symbol: string,
  upper: string,
  platform: string,
): Promise<Address> {
  const cacheKey = getMemoryCacheKey(chainId, upper);

  let coins: CoinGeckoSearchCoin[];
  try {
    coins = await searchCoinGecko(symbol);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tokenResolver] CoinGecko search timeout/failure for ${symbol}:`, msg);
    throw new TokenResolutionError(
      `Token lookup for "${symbol}" is temporarily unavailable: ${msg}`,
      { hint: `Please provide the contract address or exact token name for "${symbol}".` },
    );
  }

  const exactMatches = coins.filter(
    (c) => c.symbol?.toUpperCase() === upper,
  );
  if (exactMatches.length === 0) {
    throw new TokenResolutionError(
      `Token "${symbol}" was not found on CoinGecko.`,
      { hint: `Please provide the contract address for "${symbol}".` },
    );
  }

  exactMatches.sort((a, b) => {
    if (a.market_cap_rank === null && b.market_cap_rank === null) return 0;
    if (a.market_cap_rank === null) return 1;
    if (b.market_cap_rank === null) return -1;
    return a.market_cap_rank - b.market_cap_rank;
  });

  // Ambiguous symbol: ask the user instead of guessing. We don't fetch details
  // for every candidate here; the user can confirm one by name/address and the
  // agent will verify it through verifyAndRegisterToken.
  if (exactMatches.length > 1) {
    const list = exactMatches.map((m) => `• ${m.name}`).join("\n");
    throw new TokenResolutionError(
      `Multiple tokens match "${symbol}" on CoinGecko:\n${list}`,
      { hint: `Reply with the exact token name (e.g. "${exactMatches[0]?.name ?? symbol}") or contract address, and I will verify and register it before retrying your request.` },
    );
  }

  // Single match: fetch its contract details for this chain.
  const match = exactMatches[0];
  let detail: CoinGeckoCoinDetail;
  try {
    detail = await fetchCoinGeckoCoinDetail(match.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tokenResolver] CoinGecko coin/${match.id} failed:`, msg);
    throw new TokenResolutionError(
      `Token "${symbol}" was found on CoinGecko but the detail lookup failed: ${msg}`,
      { hint: `Please provide the contract address or exact token name for "${symbol}".` },
    );
  }

  const address = getChainAddress(detail, platform);
  if (!address || !address.startsWith("0x")) {
    let availableChains = "";
    const platformKeys = detail.platforms ? Object.keys(detail.platforms) : [];
    if (platformKeys.length > 0) {
      availableChains = platformKeys
        .map((p) => PLATFORM_TO_CHAIN_NAME[p] || p)
        .filter(Boolean)
        .join(", ");
    }
    const chainsHint = availableChains ? ` It is available on: ${availableChains}.` : "";
    throw new TokenResolutionError(
      `Token "${symbol}" (${match.name}) was found on CoinGecko but has no verified contract on chain ${chainId}.${chainsHint}`,
      { hint: `Try a different chain or provide the contract address / exact token name for "${symbol}".` },
    );
  }

  const candidate: TokenCandidate = {
    address: address as Address,
    name: detail.name || match.name,
    symbol: upper,
    chainId,
    source: "coingecko",
  };
  memoryCache.set(cacheKey, [candidate]);
  await setKvCandidates(chainId, upper, [candidate]);
  return candidate.address;
}
