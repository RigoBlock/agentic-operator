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

/** Standard headers so Cloudflare WAF doesn't block us as a bare bot. */
const STANDARD_HEADERS: Record<string, string> = {
  "user-agent": "RigoblockBazaarTrigger/1.0",
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
    console.log(`\n⚠️  ${label} — no settlement header. Settlement may have failed.`);
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

  // 3. Trigger GET /api/quote (if not already in Bazaar)
  await paidRequest(httpClient, "GET", QUOTE_URL);

  // 4. Trigger POST /api/chat — this registers the chat endpoint in Bazaar.
  //    No operator auth → manual mode → returns unsigned calldata (safe).
  await paidRequest(httpClient, "POST", CHAT_URL, {
    messages: [{ role: "user", content: "What is the price of ETH in USDC on Base?" }],
    vaultAddress: "0x0000000000000000000000000000000000000001",
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
