/**
 * 0x Swap API integration tests.
 *
 * These tests hit the live 0x API using ZEROX_API_KEY. They are skipped when
 * the key is not available, so the suite stays green in CI or on machines
 * without the dev credentials.
 *
 * Goal: catch regressions in how we construct 0x requests before they reach
 * production (e.g. wrong parameter names, unsupported exact-output mode).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getZeroXQuote } from "../src/services/zeroXTrading.js";
import type { Env, SwapIntent } from "../src/types.js";
import { readFileSync, existsSync } from "fs";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const TAKER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

function loadDevVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  if (existsSync(".dev.vars")) {
    const content = readFileSync(".dev.vars", "utf-8");
    for (const line of content.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
  }
  return vars;
}

const devVars = loadDevVars();
const ZEROX_API_KEY = process.env.ZEROX_API_KEY || devVars.ZEROX_API_KEY;
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || devVars.ALCHEMY_API_KEY;

function env(): Env {
  return {
    ZEROX_API_KEY,
    ALCHEMY_API_KEY,
  } as Env;
}

// Skip the entire integration block when no real 0x key is configured.
const hasKey = Boolean(ZEROX_API_KEY);

describe.skipIf(!hasKey)("getZeroXQuote — live 0x API", () => {
  beforeEach(() => {
    // Allow up to 10s for a live upstream round-trip.
    // Vitest does not expose a per-hook timeout override, so we rely on the
    // default 5s and keep the test payloads small/liquid.
  });

  it("fetches an exact-input quote for WETH → USDC on Base", { timeout: 15_000 }, async () => {
    const intent: SwapIntent = {
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountIn: "0.001",
      slippageBps: 100,
    };

    const quote = await getZeroXQuote(env(), intent, 8453, TAKER);

    expect(quote.buyAmount).toBeDefined();
    expect(BigInt(quote.buyAmount) > 0n).toBe(true);
    expect(quote.sellAmount).toBeDefined();
    expect(BigInt(quote.sellAmount) > 0n).toBe(true);
    expect(quote.transaction.data).not.toBe("0x");
    expect(quote.transaction.to.toLowerCase()).toBe(
      "0x0000000000001ff3684f28c67538d4d072c22734",
    );
  });

  it("fetches an exact-output quote for USDC → WETH on Base using buyAmount", { timeout: 15_000 }, async () => {
    const intent: SwapIntent = {
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountOut: "1",
      slippageBps: 100,
    };

    // Use the zero-address sentinel to prove exact-output no longer needs a
    // real vault for oracle estimation.
    const quote = await getZeroXQuote(env(), intent, 8453, ZERO_ADDR);

    // The API should honor (or slightly exceed) the requested output.
    const requestedRaw = 1_000_000n; // 1 USDC
    const actualRaw = BigInt(quote.buyAmount);
    expect(actualRaw >= requestedRaw).toBe(true);

    // sellAmount is the required input determined by 0x.
    expect(BigInt(quote.sellAmount) > 0n).toBe(true);
    expect(quote.transaction.data).not.toBe("0x");
  });
});
