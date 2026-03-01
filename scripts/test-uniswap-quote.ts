#!/usr/bin/env npx tsx
/**
 * Test script: Fetch a swap quote from the Uniswap Trading API.
 *
 * Usage:
 *   npx tsx scripts/test-uniswap-quote.ts
 *   npx tsx scripts/test-uniswap-quote.ts --sell ETH --buy USDC --amount 1
 *   npx tsx scripts/test-uniswap-quote.ts --sell USDC --buy ETH --amount 100
 *
 * Reads UNISWAP_API_KEY from .dev.vars (Wrangler local secrets file).
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// ── Parse .dev.vars ────────────────────────────────────────────────────

function loadDevVars(): Record<string, string> {
  const devVarsPath = resolve(import.meta.dirname ?? ".", "../.dev.vars");
  let content: string;
  try {
    content = readFileSync(devVarsPath, "utf-8");
  } catch {
    console.error("❌ .dev.vars not found. Copy .dev.vars.example to .dev.vars and fill in values.");
    console.error("   cp .dev.vars.example .dev.vars");
    process.exit(1);
  }
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return vars;
}

// ── CLI args ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const val = args[i + 1];
    if (key && val) flags[key] = val;
  }
  return {
    tokenIn: flags.sell?.toUpperCase() || "ETH",
    tokenOut: flags.buy?.toUpperCase() || "USDC",
    amountIn: flags.amount || "0.01",
    chainId: Number(flags.chain || "8453"), // default Base mainnet
  };
}

// ── Token map ──────────────────────────────────────────────────────────

const TOKENS: Record<number, Record<string, string>> = {
  8453: {
    // Base
    ETH: "0x0000000000000000000000000000000000000000",
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  },
  1: {
    ETH: "0x0000000000000000000000000000000000000000",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  },
  84532: {
    // Base Sepolia
    ETH: "0x0000000000000000000000000000000000000000",
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
};

function resolveToken(chainId: number, symbol: string): string {
  if (symbol.startsWith("0x")) return symbol;
  const addr = TOKENS[chainId]?.[symbol];
  if (!addr) throw new Error(`Unknown token ${symbol} on chain ${chainId}`);
  return addr;
}

function getDecimals(symbol: string): number {
  return ["USDC", "USDT"].includes(symbol) ? 6 : 18;
}

function parseUnits(amount: string, decimals: number): string {
  const [whole = "0", frac = ""] = amount.split(".");
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + padded).toString();
}

function formatUnits(amount: string, decimals: number): string {
  const s = amount.padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = s.slice(s.length - decimals).slice(0, 6);
  return `${whole}.${frac}`;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const vars = loadDevVars();
  const apiKey = vars.UNISWAP_API_KEY;
  if (!apiKey || apiKey === "your-uniswap-api-key") {
    console.error("❌ UNISWAP_API_KEY not set in .dev.vars");
    console.error("   Get one at https://developers.uniswap.org");
    process.exit(1);
  }

  const { tokenIn, tokenOut, amountIn, chainId } = parseArgs();
  const tokenInAddr = resolveToken(chainId, tokenIn);
  const tokenOutAddr = resolveToken(chainId, tokenOut);
  const decimalsIn = getDecimals(tokenIn);
  const amountRaw = parseUnits(amountIn, decimalsIn);

  // Use a well-known address as swapper (we only care about the quote, not execution)
  const DUMMY_SWAPPER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth

  const body = {
    type: "EXACT_INPUT",
    amount: amountRaw,
    tokenInChainId: chainId,
    tokenOutChainId: chainId,
    tokenIn: tokenInAddr,
    tokenOut: tokenOutAddr,
    swapper: DUMMY_SWAPPER,
    slippageTolerance: 0.5, // 0.5%
    routingPreference: "BEST_PRICE",
    urgency: "normal",
  };

  console.log(`\n🔍 Fetching Uniswap quote on chain ${chainId}...`);
  console.log(`   ${amountIn} ${tokenIn} → ${tokenOut}\n`);

  const res = await fetch("https://trade-api.gateway.uniswap.org/v1/quote", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "x-universal-router-version": "2.0",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`❌ Uniswap API error (${res.status}):`);
    console.error(err);
    process.exit(1);
  }

  const data = await res.json() as Record<string, any>;

  // Extract key fields
  const routing = data.routing;
  const quote = data.quote;

  if (!quote) {
    console.error("❌ No quote returned:");
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const inputAmount = quote.input?.amount || quote.amountIn;
  const outputAmount = quote.output?.amount || quote.amountOut;
  const decimalsOut = getDecimals(tokenOut);

  console.log(`📊 Quote (${routing || "CLASSIC"})`);
  console.log(`─────────────────────────────`);
  console.log(`Sell:   ${formatUnits(inputAmount, decimalsIn)} ${tokenIn}`);
  console.log(`Buy:    ${formatUnits(outputAmount, decimalsOut)} ${tokenOut}`);

  if (quote.gasFeeUSD) {
    console.log(`Gas:    ~$${quote.gasFeeUSD}`);
  }
  if (quote.gasUseEstimate) {
    console.log(`Gas units: ${quote.gasUseEstimate}`);
  }

  // Calculate implied price
  const inFloat = Number(inputAmount) / 10 ** decimalsIn;
  const outFloat = Number(outputAmount) / 10 ** decimalsOut;
  if (inFloat > 0) {
    const price = outFloat / inFloat;
    console.log(`Price:  1 ${tokenIn} = ${price.toFixed(4)} ${tokenOut}`);
  }

  console.log(`─────────────────────────────`);
  console.log(`\n✅ Uniswap Trading API is working!\n`);

  // Debug: print raw response
  if (process.argv.includes("--verbose")) {
    console.log("Raw response:");
    console.log(JSON.stringify(data, null, 2));
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
