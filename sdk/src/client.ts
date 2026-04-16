/**
 * x402-aware HTTP client for the Rigoblock Agentic Operator API.
 *
 * Handles:
 * - x402 payment negotiation (402 → sign → retry)
 * - Operator authentication (EIP-191 signature)
 * - Request/response serialization
 *
 * The client accepts an x402-wrapped fetch function for automatic payment
 * and optionally operator credentials for delegated execution mode.
 */

import type {
  RigoblockClientConfig,
  QuoteResponse,
  ChatResponse,
  QuoteParams,
  ChatOptions,
} from "./types.js";

const AUTH_MESSAGE = `Welcome to Rigoblock Operator\n\nSign this message to verify your wallet and access your smart pool assistant.`;

/**
 * Low-level HTTP client for the Rigoblock API.
 * Does NOT handle x402 payment signing — that is done by the x402 fetch wrapper
 * injected at construction time.
 */
export class RigoblockClient {
  private config: RigoblockClientConfig;
  private fetchFn: typeof fetch;

  /**
   * @param config - Client configuration (vault, chain, auth credentials)
   * @param fetchFn - A fetch function wrapped with x402 payment support.
   *                  Use `wrapFetchWithPayment(fetch, x402Client)` from @x402/fetch.
   *                  If not using x402, pass plain `fetch` for local testing.
   */
  constructor(config: RigoblockClientConfig, fetchFn?: typeof fetch) {
    this.config = config;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  // ─── Quote (GET /api/quote) ─────────────────────────────────────────────

  async getQuote(params: QuoteParams): Promise<QuoteResponse> {
    const url = new URL("/api/quote", this.config.baseUrl);
    url.searchParams.set("sell", params.sell);
    url.searchParams.set("buy", params.buy);
    url.searchParams.set("amount", params.amount);
    if (params.chain) url.searchParams.set("chain", params.chain);

    const res = await this.fetchFn(url.toString());
    if (!res.ok) {
      throw new Error(`Quote failed (${res.status}): ${await res.text()}`);
    }
    return res.json() as Promise<QuoteResponse>;
  }

  // ─── Chat (POST /api/chat) ─────────────────────────────────────────────

  async chat(
    message: string,
    overrides?: Partial<RigoblockClientConfig>,
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const cfg = { ...this.config, ...overrides };

    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: message }],
      vaultAddress: cfg.vaultAddress,
      chainId: cfg.chainId,
    };

    if (cfg.routingMode) {
      body.routingMode = cfg.routingMode;
    }

    if (options?.contextDocs && options.contextDocs.length > 0) {
      body.contextDocs = options.contextDocs;
    }

    // Add auth credentials for delegated mode
    if (cfg.executionMode === "delegated" && cfg.operatorAddress && cfg.authSignature) {
      body.operatorAddress = cfg.operatorAddress;
      body.authSignature = cfg.authSignature;
      body.authTimestamp = cfg.authTimestamp;
      body.executionMode = "delegated";
      body.confirmExecution = true;
    }

    const res = await this.fetchFn(`${cfg.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Chat failed (${res.status}): ${await res.text()}`);
    }
    return res.json() as Promise<ChatResponse>;
  }

  // ─── Convenience methods ───────────────────────────────────────────────

  async swap(tokenIn: string, tokenOut: string, amount: string, chain?: string): Promise<ChatResponse> {
    const chainStr = chain ? ` on ${chain}` : "";
    return this.chat(`swap ${amount} ${tokenIn} for ${tokenOut}${chainStr}`);
  }

  async addLiquidity(
    token0: string,
    token1: string,
    amount0: string,
    amount1: string,
    chain: string,
  ): Promise<ChatResponse> {
    return this.chat(
      `add liquidity to ${token0}/${token1} pool with ${amount0} ${token0} and ${amount1} ${token1} on ${chain}`,
    );
  }

  async removeLiquidity(positionId: string, chain: string): Promise<ChatResponse> {
    return this.chat(`remove LP position ${positionId} on ${chain}`);
  }

  async getLpPositions(chain?: string): Promise<ChatResponse> {
    const chainStr = chain ? ` on ${chain}` : "";
    return this.chat(`show LP positions${chainStr}`);
  }

  async gmxOpen(
    market: string,
    direction: string,
    collateral: string,
    collateralAmount: string,
    leverage = 1,
  ): Promise<ChatResponse> {
    return this.chat(
      `open a ${leverage}x ${direction} ${market} position with ${collateralAmount} ${collateral} collateral on GMX`,
    );
  }

  async gmxClose(market: string, direction: string): Promise<ChatResponse> {
    return this.chat(`close my ${direction} ${market} position on GMX`);
  }

  async gmxPositions(): Promise<ChatResponse> {
    return this.chat("show my GMX positions");
  }

  async bridge(token: string, amount: string, fromChain: string, toChain: string): Promise<ChatResponse> {
    return this.chat(`bridge ${amount} ${token} from ${fromChain} to ${toChain}`);
  }

  async vaultInfo(chain?: string): Promise<ChatResponse> {
    const chainStr = chain ? ` on ${chain}` : "";
    return this.chat(`show vault info${chainStr}`);
  }

  async aggregatedNav(): Promise<ChatResponse> {
    return this.chat("show aggregated NAV across all chains");
  }

  // ─── Auth helpers ──────────────────────────────────────────────────────

  /**
   * Returns the auth message that needs to be signed by the operator wallet
   * using EIP-191 personal_sign.
   */
  static getAuthMessage(): string {
    return AUTH_MESSAGE;
  }

  /**
   * Update auth credentials (e.g., after signing).
   */
  setAuth(operatorAddress: string, signature: string, timestamp: number): void {
    this.config.operatorAddress = operatorAddress;
    this.config.authSignature = signature;
    this.config.authTimestamp = timestamp;
    this.config.executionMode = "delegated";
  }

  /**
   * Switch execution mode.
   */
  setExecutionMode(mode: "manual" | "delegated"): void {
    this.config.executionMode = mode;
  }

  /**
   * Switch chain.
   */
  setChain(chainId: number): void {
    this.config.chainId = chainId;
  }
}
