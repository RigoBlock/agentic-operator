/// <reference types="node" />
/**
 * Test x402 v2 payment — triggers Bazaar cataloging.
 *
 * Makes real x402 payments to all x402-gated endpoints:
 *   GET /api/quote, POST /api/quote/uniswap, GET /api/quote/0x,
 *   POST /api/oracle/refresh, POST /api/chat, GET /api/tools, POST /api/tools
 * This causes the facilitator to auto-catalog each endpoint in the x402 Bazaar.
 *
 * Requirements:
 *   - A wallet with ≥$0.02 USDC on Base mainnet
 *   - Interactive terminal (for hidden private-key prompt) OR TEST_PRIVATE_KEY env var
 *
 * Usage:
 *   npm run register:bazaar
 *   # or with env var (CI / non-TTY):
 *   TEST_PRIVATE_KEY=0x... npm run register:bazaar
 */

import { createInterface } from "readline";
import { createWalletClient, http, maxUint256, parseAbi, type Hex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { publicActions } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme, PERMIT2_ADDRESS, UptoEvmScheme, toClientEvmSigner } from "@x402/evm";

const BASE_URL = "https://trader.rigoblock.com";
const QUOTE_URL = `${BASE_URL}/api/quote?sell=ETH&buy=USDC&amount=1&chain=base`;
const QUOTE_UNISWAP_URL = `${BASE_URL}/api/quote/uniswap`;
// 0x API uses 0xEeee... for native ETH, not zero address (query params forwarded verbatim)
const QUOTE_0X_URL = `${BASE_URL}/api/quote/0x?chainId=8453&sellToken=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&buyToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&sellAmount=1000000000000000000`;
const CHAT_URL = `${BASE_URL}/api/chat`;
const TOOLS_GET_URL = `${BASE_URL}/api/tools`;
const TOOLS_POST_URL = `${BASE_URL}/api/tools?toolName=get_swap_quote`;
const ORACLE_REFRESH_URL = `${BASE_URL}/api/oracle/refresh`;

/** Minimal headers. DO NOT add Origin or Referer — the Worker exempts its own frontends. */
const STANDARD_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (compatible; RigoblockBazaarTrigger/1.0; +https://trader.rigoblock.com)",
  "accept": "application/json",
};

/** Prompt for hidden input (password-style). Falls back to plain readline in non-TTY. */
async function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdout = process.stdout;
    const stdin = process.stdin;

    stdout.write(question);

    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin, output: stdout });
      rl.question("", (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let input = "";

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          resolve(input);
          return;
        } else if (ch === "\u0003") {
          process.exit(1);
        } else if (ch === "\u007f") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            stdout.write("\b \b");
          }
        } else {
          input += ch;
          stdout.write("*");
        }
      }
    };

    stdin.on("data", onData);
  });
}

/** Fetch private key from env or prompt interactively. */
async function getPrivateKey(): Promise<string> {
  const envPk = process.env.TEST_PRIVATE_KEY;
  if (envPk) {
    console.log("Using TEST_PRIVATE_KEY from environment.\n");
    return envPk;
  }
  return promptHidden("Enter private key (with 0x prefix): ");
}

/** Makes a paid x402 request. Returns true only if payment was required, made, and settled. */
async function paidRequest(
  httpClient: x402HTTPClient,
  method: "GET" | "POST",
  url: string,
  body?: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<boolean> {
  const label = `${method} ${new URL(url).pathname}`;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`→ ${label}`);

  try {
    // 1. Initial request — expect 402
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const initOpts: RequestInit = {
      method,
      headers: { ...STANDARD_HEADERS },
      signal: controller.signal,
    };
    if (body) {
      (initOpts.headers as Record<string, string>)["content-type"] = "application/json";
      initOpts.body = JSON.stringify(body);
    }
    const res = await fetch(url, initOpts);
    clearTimeout(timer);
    console.log(`← ${res.status} ${res.statusText}`);

    if (res.status !== 402) {
      const bodyText = await res.text();
      console.log("❌ Not behind paywall — x402 was skipped. Body:", bodyText.slice(0, 300));
      console.log("   Common causes:");
      console.log("   1. Origin/Referer headers match the Worker’s exempt origins (removed in this script)");
      console.log("   2. Cloudflare WAF blocked the request before the Worker");
      console.log("   3. The route returned an auth error before x402 could run");
      return false;
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

    // 4. Retry with payment
    const paidController = new AbortController();
    const paidTimer = setTimeout(() => paidController.abort(), timeoutMs);

    const paidOpts: RequestInit = {
      method,
      headers: { ...STANDARD_HEADERS, ...payHeaders },
      signal: paidController.signal,
    };
    if (body) {
      (paidOpts.headers as Record<string, string>)["content-type"] = "application/json";
      paidOpts.body = JSON.stringify(body);
    }
    const paidRes = await fetch(url, paidOpts);
    clearTimeout(paidTimer);
    console.log(`← ${paidRes.status} ${paidRes.statusText}`);

    if (!paidRes.ok) {
      const errorText = await paidRes.text();
      console.log(`\n❌ ${label} — Worker returned ${paidRes.status}. Settlement SKIPPED.`);
      console.log("Response body:", errorText.slice(0, 500));
      const newPayHdr = paidRes.headers.get("payment-required");
      if (newPayHdr) {
        try {
          const decoded = JSON.parse(Buffer.from(newPayHdr, "base64").toString());
          console.log("  payment-required error:", decoded?.error ?? "?");
        } catch { /* ignore */ }
      }
      return false;
    }

    const responseText = await paidRes.text();
    console.log("Response:", responseText.length > 500 ? responseText.slice(0, 500) + "…" : responseText);

    // 5. Check settlement
    const settle = paidRes.headers.get("PAYMENT-RESPONSE") || paidRes.headers.get("X-PAYMENT-RESPONSE");
    console.log("\nPayment headers:");
    paidRes.headers.forEach((v, k) => {
      if (k.toLowerCase().includes("payment")) console.log(`  ${k}: ${v.slice(0, 80)}…`);
    });
    if (settle) {
      console.log(`\n✅ ${label} — payment settled! Bazaar will catalog this endpoint.`);
      return true;
    } else {
      console.log(`\n❌ ${label} — NO settlement header. Payment was NOT cataloged.`);
      return false;
    }
  } catch (err: any) {
    console.log(`\n❌ ${label} — Request failed: ${err.message ?? err}`);
    if (err.cause) console.log("   Cause:", err.cause.message ?? err.cause);
    return false;
  }
}

async function main() {
  let pkInput = await getPrivateKey();
  if (!pkInput || !pkInput.startsWith("0x")) {
    console.error("Private key must start with 0x");
    process.exit(1);
  }

  // Create viem account and wallet immediately, then discard the raw key
  let account = privateKeyToAccount(pkInput as Hex);

  // Overwrite the raw key string (best-effort; strings are immutable in JS)
  // We reassign and null out every reference we control.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let _wiped = pkInput;
  _wiped = "0x" + "0".repeat(64);
  // @ts-ignore — force drop the binding from this scope
  pkInput = undefined;
  _wiped = ""; // final overwrite

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  }).extend(publicActions);

  let signer = toClientEvmSigner(account, walletClient);

  // Build x402 v2 client
  let client = new x402Client();
  client.register("eip155:8453", new ExactEvmScheme(signer));
  client.register("eip155:8453", new UptoEvmScheme(signer));
  let httpClient = new x402HTTPClient(client);

  // Ensure USDC is approved for Permit2
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const minAllowance = 100_000n;
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
    console.log(`  Allowance OK. No approval needed.`);
  }

  const endpoints = [
    { label: "GET /api/quote", fn: () => paidRequest(httpClient, "GET", QUOTE_URL) },
    {
      label: "POST /api/quote/uniswap",
      fn: () => paidRequest(httpClient, "POST", QUOTE_UNISWAP_URL, {
        type: "EXACT_INPUT",
        amount: "1000000000000000000",
        tokenIn: "0x0000000000000000000000000000000000000000",
        tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenInChainId: 8453,
        tokenOutChainId: 8453,
        swapper: account.address,
      }),
    },
    {
      label: "GET /api/quote/0x",
      fn: () => paidRequest(httpClient, "GET", `${QUOTE_0X_URL}&taker=${account.address}`),
    },
    {
      label: "POST /api/chat",
      fn: () => paidRequest(httpClient, "POST", CHAT_URL, {
        messages: [{ role: "user", content: "What can you help me with? Briefly describe your capabilities." }],
        vaultAddress: "0x0000000000000000000000000000000000000000",
        chainId: 8453,
      }, 60000),
    },
    {
      label: "POST /api/oracle/refresh",
      fn: () => paidRequest(httpClient, "POST", ORACLE_REFRESH_URL, {
        token: "GRG",
        chainId: 8453,
        direction: "buy",
        amount: "0.001",
      }),
    },
    { label: "GET /api/tools", fn: () => paidRequest(httpClient, "GET", TOOLS_GET_URL) },
    {
      label: "POST /api/tools",
      fn: () => paidRequest(httpClient, "POST", TOOLS_POST_URL, {
        arguments: { tokenIn: "ETH", tokenOut: "USDC", amountIn: "1" },
        chainId: 8453,
      }),
    },
  ];

  let settledCount = 0;
  let failedCount = 0;

  for (const ep of endpoints) {
    const settled = await ep.fn();
    if (settled) {
      settledCount++;
    } else {
      failedCount++;
    }
    // 8s delay between endpoints (skip if this was the last one)
    const isLast = endpoints.indexOf(ep) === endpoints.length - 1;
    if (!isLast) {
      await new Promise((r) => setTimeout(r, 8000));
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Done. ${settledCount} payments settled (Bazaar cataloged), ${failedCount} failed.`);
  if (settledCount > 0) {
    console.log("Check Bazaar listings:");
    console.log("  curl 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=rigoblock' | jq '.'")
    console.log("  https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources");
  }

  // Wipe every object that touches or references the private key
  // @ts-ignore
  signer = null;
  // @ts-ignore
  client = null;
  // @ts-ignore
  httpClient = null;
  account = null as any;
  // walletClient extends the account — dropping the above is enough
  // for GC to collect the whole graph once we exit.

  // Force exit — viem keeps HTTP handles alive, preventing clean shutdown
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
