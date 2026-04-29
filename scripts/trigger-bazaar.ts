/// <reference types="node" />
/**
 * Test x402 v2 payment — triggers Bazaar cataloging.
 *
 * Makes real x402 payments to both GET /api/quote and POST /api/chat,
 * which causes the facilitator to auto-catalog each endpoint in the x402 Bazaar.
 *
 * Requirements:
 *   - A wallet with ≥$0.02 USDC on Base mainnet
 *   - Set TEST_PRIVATE_KEY env var
 *
 * Usage:
 *   TEST_PRIVATE_KEY=0x... npx tsx scripts/trigger-bazaar.ts
 */

import { createWalletClient, http, type Hex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { publicActions } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";

const BASE_URL = "https://trader.rigoblock.com";
const QUOTE_URL = `${BASE_URL}/api/quote?sell=ETH&buy=USDC&amount=1&chain=base`;
const CHAT_URL = `${BASE_URL}/api/chat`;
const TOOLS_URL = `${BASE_URL}/api/tools/get_swap_quote`;

/** Standard headers — use a browser-like UA so Cloudflare Bot Fight Mode doesn't block us. */
const STANDARD_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (compatible; RigoblockBazaarTrigger/1.0; +https://trader.rigoblock.com)",
  "accept": "application/json",
};

/** Makes a paid x402 request and logs settlement result. */
async function paidRequest(
  httpClient: x402HTTPClient,
  method: "GET" | "POST",
  url: string,
  body?: Record<string, unknown>,
): Promise<void> {
  const label = `${method} ${new URL(url).pathname}`;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`→ ${label}`);

  // 1. Initial request — expect 402
  const initOpts: RequestInit = { method, headers: { ...STANDARD_HEADERS } };
  if (body) {
    (initOpts.headers as Record<string, string>)["content-type"] = "application/json";
    initOpts.body = JSON.stringify(body);
  }
  const res = await fetch(url, initOpts);
  console.log(`← ${res.status} ${res.statusText}`);

  if (res.status !== 402) {
    console.log("Not behind paywall. Body:", await res.text());
    return;
  }

  // 2. Parse 402 payment requirements
  const resBody = await res.json() as Record<string, unknown>;
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name: string) => res.headers.get(name),
    resBody,
  );
  console.log("Price:", JSON.stringify(paymentRequired.accepts?.[0], null, 2));

  // 3. Create payment payload (signs USDC transfer authorization)
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const payHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  // 4. Retry with payment (merge standard + content-type for POST)
  const paidOpts: RequestInit = { method, headers: { ...STANDARD_HEADERS, ...payHeaders } };
  if (body) {
    (paidOpts.headers as Record<string, string>)["content-type"] = "application/json";
    paidOpts.body = JSON.stringify(body);
  }
  const paidRes = await fetch(url, paidOpts);
  console.log(`← ${paidRes.status} ${paidRes.statusText}`);

  if (!paidRes.ok) {
    const errorText = await paidRes.text();
    console.log(`\n❌ ${label} — Worker returned ${paidRes.status}. Settlement SKIPPED.`);
    console.log("Response body:", errorText.slice(0, 500));
    // Decode the new payment-required header (if any) for diagnostics
    const newPayHdr = paidRes.headers.get("payment-required");
    if (newPayHdr) {
      try {
        const decoded = JSON.parse(Buffer.from(newPayHdr, "base64").toString());
        console.log("  payment-required error:", decoded?.error ?? "?");
        console.log("  payment-required resource:", decoded?.resource?.url ?? "?");
        console.log("  payment-required accepts:", JSON.stringify(decoded?.accepts?.[0]).slice(0, 200));
      } catch { /* ignore */ }
    }
    console.log("  payment-payload accepted:", JSON.stringify((paymentPayload as any).accepted).slice(0, 200));
    console.log("Fix: check Worker logs with: wrangler tail");
    return;
  }

  const responseText = await paidRes.text();
  // Truncate long LLM responses for readability
  console.log("Response:", responseText.length > 500 ? responseText.slice(0, 500) + "…" : responseText);

  // 5. Check settlement
  const settle = paidRes.headers.get("PAYMENT-RESPONSE") || paidRes.headers.get("X-PAYMENT-RESPONSE");
  console.log("\nPayment headers:");
  paidRes.headers.forEach((v, k) => {
    if (k.toLowerCase().includes("payment")) console.log(`  ${k}: ${v.slice(0, 80)}…`);
  });
  if (settle) {
    console.log(`\n✅ ${label} — payment settled! Bazaar will catalog this endpoint.`);
  } else {
    console.log(`\n❌ ${label} — NO settlement header.`);
    console.log("   Possible causes:");
    console.log("   1. Route returned 4xx/5xx — settlement is skipped on non-2xx responses");
    console.log("   2. CDP facilitator rejected the settlement (bad CDP_API_KEY_ID/SECRET in Worker)");
    console.log("   3. Workers AI binding unavailable (check Cloudflare dashboard)");
    console.log("   Check the deployed Worker's logs: wrangler tail --env production");
  }
}

async function main() {
  const pk = process.env.TEST_PRIVATE_KEY;
  if (!pk) {
    console.error("Set TEST_PRIVATE_KEY env var (private key with USDC on Base)");
    process.exit(1);
  }

  // 1. Create viem signer on Base mainnet
  const account = privateKeyToAccount(pk as Hex);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  }).extend(publicActions);

  const signer = toClientEvmSigner(account, walletClient);

  // 2. Build x402 v2 client
  const client = new x402Client();
  client.register("eip155:8453", new ExactEvmScheme(signer));
  const httpClient = new x402HTTPClient(client);

  // 3. Trigger GET /api/quote — registers the quote endpoint in Bazaar.
  await paidRequest(httpClient, "GET", QUOTE_URL);

  // Wait for quote settlement to be mined (Base: 2s blocks). EIP-2612 permit nonces are
  // sequential on-chain — if settlement for nonce N is still pending when the next payment
  // is created with nonce N+1, the CDP facilitator may reject nonce N+1 as a race.
  // 8s gives 4 block confirmations of headroom.
  await new Promise((r) => setTimeout(r, 8000));

  // 4. Trigger POST /api/chat — registers the full trading chat in Bazaar.
  //    IMPORTANT: use a message that doesn't invoke any tools (no network calls
  //    to Uniswap/0x/etc.) to guarantee a fast 200 and successful settlement.
  //    "What can you do?" → LLM responds from system prompt, no tools needed.
  //    No operator auth → manual mode only (unsigned tx data, never executes).
  await paidRequest(httpClient, "POST", CHAT_URL, {
    messages: [{ role: "user", content: "What can you help me with? Briefly describe your capabilities." }],
    vaultAddress: "0x0000000000000000000000000000000000000000",
    chainId: 8453,
  });

  // Wait for chat settlement to be mined before creating tools payment.
  await new Promise((r) => setTimeout(r, 8000));

  // 5. Trigger POST /api/tools/* — registers the direct tool invocation endpoint.
  //    Use get_swap_quote (read-only, fast) with a well-known token pair.
  //    NOTE: Total spend is ~$0.014 USDC (quote $0.002 + chat $0.01 + tools $0.002).
  //    Ensure your wallet has at least $0.02 USDC on Base mainnet.
  await paidRequest(httpClient, "POST", TOOLS_URL, {
    arguments: {
      tokenIn: "ETH",
      tokenOut: "USDC",
      amountIn: "1",
      chain: "base",
    },
    vaultAddress: "0x0000000000000000000000000000000000000000",
    chainId: 8453,
  });

  console.log("\n" + "=".repeat(60));
  console.log("Done. Check Bazaar listings:");
  console.log("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources");

  // Force exit — viem keeps HTTP handles alive, preventing clean shutdown
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
