/**
 * Test x402 v2 payment — triggers Bazaar cataloging.
 *
 * Makes a real x402 payment to GET /api/quote, which causes the facilitator
 * to auto-catalog the endpoint in the x402 Bazaar.
 *
 * Requirements:
 *   - A wallet with ≥$0.01 USDC on Base mainnet
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

const API_URL = "https://trader.rigoblock.com/api/quote?sell=ETH&buy=USDC&amount=1&chain=base";

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

  // 2. Build x402 v2 client with EVM exact scheme on Base mainnet (eip155:8453)
  const client = new x402Client();
  client.register("eip155:8453", new ExactEvmScheme(signer));
  const httpClient = new x402HTTPClient(client);

  // 3. First request — expect 402
  console.log(`→ GET ${API_URL}`);
  const res = await fetch(API_URL);
  console.log(`← ${res.status} ${res.statusText}`);

  if (res.status !== 402) {
    console.log("Not behind paywall (exempt origin, or route not matched). Body:");
    console.log(await res.text());
    return;
  }

  // 4. Parse 402 response (v2: requirements in PAYMENT-REQUIRED header, base64-encoded)
  const body = await res.json() as Record<string, unknown>;

  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name: string) => res.headers.get(name),
    body,
  );
  console.log("Payment requirements:", JSON.stringify(paymentRequired, null, 2));

  // 5. Create payment payload (signs USDC transfer authorisation)
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const headers = httpClient.encodePaymentSignatureHeader(paymentPayload);
  console.log("Payment header created, retrying with X-PAYMENT…");

  // 6. Retry with payment
  const paidRes = await fetch(API_URL, { headers });
  console.log(`← ${paidRes.status} ${paidRes.statusText}`);
  console.log("Response:", await paidRes.text());

  // 7. Check settlement (SDK uses "PAYMENT-RESPONSE" header, not "X-PAYMENT-RESPONSE")
  const settle = paidRes.headers.get("PAYMENT-RESPONSE") || paidRes.headers.get("X-PAYMENT-RESPONSE");
  console.log("\nResponse headers:");
  paidRes.headers.forEach((v, k) => {
    if (k.toLowerCase().includes("payment")) console.log(`  ${k}: ${v}`);
  });
  if (settle) {
    console.log("\n✅ Payment settled! X-PAYMENT-RESPONSE:", settle);
    console.log("\nThe facilitator has now cataloged this endpoint in the x402 Bazaar.");
    console.log("Check: https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources");
  } else {
    console.log("\n⚠️  No X-PAYMENT-RESPONSE header — settlement may have failed.");
  }
}

main().catch(console.error);
