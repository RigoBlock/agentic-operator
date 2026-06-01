/// <reference types="node" />
/**
 * Test x402 v2 payment — triggers Bazaar cataloging.
 *
 * Makes real x402 payments to all x402-gated endpoints:
 *   GET /api/quote, POST /api/quote/uniswap, GET /api/quote/0x,
 *   POST /api/chat, GET /api/tools
 * This causes the facilitator to auto-catalog each endpoint in the x402 Bazaar.
 *
 * Requirements:
 *   - A wallet with ≥$0.02 USDC on Base mainnet
 *   - Set TEST_PRIVATE_KEY env var
 *
 * Usage:
 *   TEST_PRIVATE_KEY=0x... npx tsx scripts/trigger-bazaar.ts
 */

import { createWalletClient, http, maxUint256, parseAbi, type Hex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { publicActions } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme, PERMIT2_ADDRESS, UptoEvmScheme, toClientEvmSigner } from "@x402/evm";

const BASE_URL = "https://trader.rigoblock.com";
const QUOTE_URL = `${BASE_URL}/api/quote?sell=ETH&buy=USDC&amount=1&chain=base`;
const QUOTE_UNISWAP_URL = `${BASE_URL}/api/quote/uniswap`;
const QUOTE_0X_URL = `${BASE_URL}/api/quote/0x?chainId=8453&sellToken=ETH&buyToken=USDC&sellAmount=1000000000000000000`;
const CHAT_URL = `${BASE_URL}/api/chat`;
const TOOLS_URL = `${BASE_URL}/api/tools`;

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

  // 2. Build x402 v2 client — register both exact (quote, tools) and upto (chat) schemes
  const client = new x402Client();
  client.register("eip155:8453", new ExactEvmScheme(signer));
  client.register("eip155:8453", new UptoEvmScheme(signer));
  const httpClient = new x402HTTPClient(client);

  // 3. Ensure USDC is approved for the Permit2 contract.
  //    The upto scheme uses permit2 PermitBatch to sign a spending authorisation.
  //    Permit2 needs an ERC-20 allowance before it can move USDC on the payer's behalf.
  //    This approval is a one-time on-chain transaction; subsequent runs skip it.
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const minAllowance = 100_000n; // $0.10 in µUSDC (the max upto authorisation amount)
  const erc20Abi = parseAbi([
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ]);
  console.log(`\nChecking USDC permit2 allowance (needed for upto scheme / POST /api/chat)...`);
  const currentAllowance = await walletClient.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, PERMIT2_ADDRESS],
  });
  if (currentAllowance < minAllowance) {
    console.log(`  Allowance ${currentAllowance} µUSDC < ${minAllowance} µUSDC required — approving permit2...`);
    const hash = await walletClient.writeContract({
      address: USDC_BASE,
      abi: erc20Abi,
      functionName: "approve",
      args: [PERMIT2_ADDRESS, maxUint256],
    });
    console.log(`  Approval tx: ${hash}. Waiting for confirmation...`);
    await walletClient.waitForTransactionReceipt({ hash });
    console.log(`  Permit2 approval confirmed.`);
  } else {
    console.log(`  Allowance OK (${currentAllowance} µUSDC). No approval needed.`);
  }

  // 4. Trigger GET /api/quote — registers the quote endpoint in Bazaar.
  await paidRequest(httpClient, "GET", QUOTE_URL);
  await new Promise((r) => setTimeout(r, 8000));

  // 5. Trigger POST /api/quote/uniswap — registers the Uniswap oracle-enriched quote endpoint.
  await paidRequest(httpClient, "POST", QUOTE_UNISWAP_URL, {
    type: "EXACT_INPUT",
    amount: "1000000000000000000",
    tokenIn: "0x0000000000000000000000000000000000000000",
    tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    tokenInChainId: 8453,
    tokenOutChainId: 8453,
  });
  await new Promise((r) => setTimeout(r, 8000));

  // 6. Trigger GET /api/quote/0x — registers the 0x oracle-enriched quote endpoint.
  //    The 0x allowance-holder/quote endpoint requires a taker address.
  const quote0xUrlWithTaker = `${QUOTE_0X_URL}&taker=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`;
  await paidRequest(httpClient, "GET", quote0xUrlWithTaker);
  await new Promise((r) => setTimeout(r, 8000));

  // 7. Trigger POST /api/chat — registers the full trading chat in Bazaar.
  //    IMPORTANT: use a message that doesn't invoke any tools (no network calls
  //    to Uniswap/0x/etc.) to guarantee a fast 200 and successful settlement.
  //    "What can you do?" → LLM responds from system prompt, no tools needed.
  //    No operator auth → manual mode only (unsigned tx data, never executes).
  //    Payment is via upto scheme: authorises up to $0.10 but only charges actual
  //    inference cost (~$0.003-$0.015). The Settlement-Overrides header on the
  //    200 response carries the exact billed amount back to the CDP facilitator.
  await paidRequest(httpClient, "POST", CHAT_URL, {
    messages: [{ role: "user", content: "What can you help me with? Briefly describe your capabilities." }],
    vaultAddress: "0x0000000000000000000000000000000000000000",
    chainId: 8453,
  });
  await new Promise((r) => setTimeout(r, 8000));

  // 8. Trigger GET /api/tools — registers the direct tool invocation endpoint.
  //    Uses the GET /api/tools discovery endpoint (returns tools listing).
  //    This is an exact-URL resource (not a wildcard) so the bazaar extension
  //    can proactively pre-declare it, same as GET /api/quote.
  //    NOTE: Total spend is ~$0.016-$0.028 USDC (quote $0.002 + uniswap $0.002 + 0x $0.002
  //    + chat ~$0.008 + tools $0.002). Ensure your wallet has at least $0.04 USDC on Base.
  await paidRequest(httpClient, "GET", TOOLS_URL);

  console.log("\n" + "=".repeat(60));
  console.log("Done. Check Bazaar listings:");
  console.log("  curl 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=rigoblock' | jq '.'")
  console.log("  https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources");

  // Force exit — viem keeps HTTP handles alive, preventing clean shutdown
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
