/**
 * Wallet routes — POST /api/wallet/*
 *
 * Encrypted self-custodial WDK wallet endpoints:
 *
 *   POST /create          → Generate WDK wallet, encrypt with password,
 *                            return encrypted keystore (seed shown once for backup)
 *   POST /derive-address  → Derive address from seed phrase (validation)
 *   POST /prepare-tx      → Prepare a gas-sponsored UserOp (EIP-7702) for client signing
 *   POST /submit-signed   → Submit a client-signed UserOp to Alchemy bundler
 *   POST /rpc             → Proxy RPC calls to Alchemy
 *
 * Security model:
 *   - Seed phrase encrypted with user's password (PBKDF2 + AES-256-GCM)
 *   - Server returns encrypted keystore — never stores seed or password
 *   - Browser decrypts locally, signs locally, wipes key from memory
 *   - For 7702 gas sponsorship: server prepares → browser signs → server submits
 *   - Not x402-gated — agents/users need a wallet BEFORE they can pay x402
 */

import { Hono } from "hono";
import type { Env } from "../types.js";
import type { Address, Hex, Chain } from "viem";
import {
  generateEncryptedWallet,
  deriveWdkAddress,
} from "../services/userWallet.js";
import { LocalAccountSigner } from "@aa-sdk/core";
import { createSmartWalletClient } from "@account-kit/wallet-client";
import {
  alchemy,
  mainnet as alchemyMainnet,
  optimism as alchemyOptimism,
  polygon as alchemyPolygon,
  base as alchemyBase,
  arbitrum as alchemyArbitrum,
  bsc as alchemyBsc,
  sepolia as alchemySepolia,
  baseSepolia as alchemyBaseSepolia,
  unichainMainnet as alchemyUnichain,
} from "@account-kit/infra";

// ── Alchemy Chain Map ────────────────────────────────────────────────

const ALCHEMY_CHAIN_MAP: Record<number, Chain> = {
  1: alchemyMainnet,
  10: alchemyOptimism,
  56: alchemyBsc,
  130: alchemyUnichain,
  137: alchemyPolygon,
  8453: alchemyBase,
  42161: alchemyArbitrum,
  11155111: alchemySepolia,
  84532: alchemyBaseSepolia,
};

// ── Alchemy RPC proxy ────────────────────────────────────────────────

const ALCHEMY_RPC: Record<number, string> = {
  1: "eth-mainnet",
  10: "opt-mainnet",
  56: "bnb-mainnet",
  130: "unichain-mainnet",
  137: "polygon-mainnet",
  8453: "base-mainnet",
  42161: "arb-mainnet",
  11155111: "eth-sepolia",
  84532: "base-sepolia",
};

const ALLOWED_RPC_METHODS = new Set([
  "eth_getTransactionReceipt",
  "eth_estimateGas",
  "eth_call",
  "eth_getBalance",
  "eth_blockNumber",
  "eth_chainId",
  "eth_getTransactionCount",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_sendRawTransaction",
]);

async function alchemyRpc(
  chainId: number,
  apiKey: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const network = ALCHEMY_RPC[chainId];
  if (!network) throw new Error(`Chain ${chainId} not supported for RPC`);
  const url = `https://${network}.g.alchemy.com/v2/${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Alchemy domain-restricted keys require Origin — Cloudflare Workers
      // don't send one by default, causing "Unspecified error" responses.
      "Origin": "https://trader.rigoblock.com",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alchemy RPC error (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    result?: unknown;
    error?: { message: string };
  };
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

// ── Routes ────────────────────────────────────────────────────────────

export const wallet = new Hono<{ Bindings: Env }>();

/**
 * POST /api/wallet/create
 * Generate a new WDK wallet encrypted with a user-chosen password.
 *
 * The seed phrase is encrypted with PBKDF2 + AES-256-GCM. The server
 * returns the encrypted keystore (safe to store) and the plaintext
 * seed phrase (shown ONCE for backup, then discarded by the browser).
 *
 * Body: { password: string } (min 8 chars)
 * Returns: { keystore: EncryptedKeystore, seedPhrase: string }
 */
wallet.post("/create", async (c) => {
  try {
    const body = await c.req.json();
    const password = body.password;
    if (!password || typeof password !== "string" || password.length < 8) {
      return c.json({ error: "Password required (min 8 characters)" }, 400);
    }

    const { keystore, seedPhrase } = await generateEncryptedWallet(password);
    return c.json({ keystore, seedPhrase });
  } catch (err) {
    console.error("[Wallet] Create failed:", err);
    return c.json({ error: "Failed to create wallet" }, 500);
  }
});

/**
 * POST /api/wallet/derive-address
 * Derive the Ethereum address from a BIP-39 seed phrase.
 * Used for validation (e.g. confirming import was correct).
 * Body: { seedPhrase: string }
 */
wallet.post("/derive-address", async (c) => {
  try {
    const body = await c.req.json();
    const seedPhrase = body.seedPhrase?.trim();
    if (!seedPhrase) return c.json({ error: "seedPhrase required" }, 400);

    const words = seedPhrase.split(/\s+/);
    if (words.length !== 12) {
      return c.json({ error: "Seed phrase must be 12 words" }, 400);
    }

    const address = deriveWdkAddress(seedPhrase);
    return c.json({ address });
  } catch (err) {
    console.error("[Wallet] Derive address failed:", err);
    return c.json({ error: "Invalid seed phrase" }, 500);
  }
});

/**
 * POST /api/wallet/prepare-tx
 * Prepare a gas-sponsored UserOp for client signing via EIP-7702.
 *
 * The server calls Alchemy's prepareCalls() — this does NOT need the
 * private key, only the user's address. Returns the prepared UserOp
 * data that the browser must sign with the user's local key.
 *
 * Body: { address: string, chainId: number, calls: [{ to, data, value }] }
 * Returns: { preparedCalls: object } (serialized for client signing)
 */
wallet.post("/prepare-tx", async (c) => {
  try {
    const body = await c.req.json();
    const { address, chainId, calls } = body;
    if (!address || !chainId || !calls?.length) {
      return c.json({ error: "address, chainId, and calls required" }, 400);
    }

    const policyId = c.env.ALCHEMY_GAS_POLICY_ID;
    if (!policyId) {
      return c.json({ error: "Gas sponsorship not configured" }, 500);
    }

    const alchemyChain = ALCHEMY_CHAIN_MAP[chainId];
    if (!alchemyChain) {
      return c.json({ error: `Chain ${chainId} not supported for gas sponsorship` }, 400);
    }

    // Create a dummy signer just for the client setup — prepareCalls
    // only needs the address, not the private key. We use a throwaway
    // key and override the `from` field with the real user address.
    const { privateKeyToAccount } = await import("viem/accounts");
    // Deterministic throwaway key (never signs anything meaningful)
    const dummyAccount = privateKeyToAccount(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
    const dummySigner = new LocalAccountSigner(dummyAccount);

    const transport = alchemy({
      apiKey: c.env.ALCHEMY_API_KEY,
      fetchOptions: {
        headers: { Origin: "https://trader.rigoblock.com" },
      },
    });

    const client = createSmartWalletClient({
      transport,
      chain: alchemyChain,
      signer: dummySigner,
    });

    console.log(`[Wallet] prepareCalls for ${address} on chain ${chainId}`);

    const preparedCalls = await client.prepareCalls({
      calls: calls.map((c: { to: string; data?: string; value?: string }) => ({
        to: c.to as Address,
        data: (c.data || "0x") as Hex,
        value: (c.value || "0x0") as Hex,
      })),
      from: address as Address,
      capabilities: {
        paymasterService: { policyId },
      },
    });

    // Serialize prepared calls for the client
    // The client needs to sign this and send it back
    return c.json({
      preparedCalls: JSON.parse(
        JSON.stringify(preparedCalls, (_key, value) =>
          typeof value === "bigint" ? `0x${value.toString(16)}` : value,
        ),
      ),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Wallet] prepare-tx failed:", msg);
    return c.json({ error: `Preparation failed: ${msg}` }, 500);
  }
});

/**
 * POST /api/wallet/submit-signed
 * Submit a client-signed UserOp to the Alchemy bundler.
 *
 * The browser has signed the prepared calls locally — this endpoint
 * just submits the already-signed blob and waits for confirmation.
 * No private key is involved server-side.
 *
 * Body: { chainId: number, signedCalls: object }
 * Returns: { txHash: string, status: string }
 */
wallet.post("/submit-signed", async (c) => {
  try {
    const body = await c.req.json();
    const { chainId, signedCalls } = body;
    if (!chainId || !signedCalls) {
      return c.json({ error: "chainId and signedCalls required" }, 400);
    }

    const alchemyChain = ALCHEMY_CHAIN_MAP[chainId];
    if (!alchemyChain) {
      return c.json({ error: `Chain ${chainId} not supported` }, 400);
    }

    // Create a throwaway client for send + wait
    const { privateKeyToAccount } = await import("viem/accounts");
    const dummyAccount = privateKeyToAccount(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
    const dummySigner = new LocalAccountSigner(dummyAccount);

    const transport = alchemy({
      apiKey: c.env.ALCHEMY_API_KEY,
      fetchOptions: {
        headers: { Origin: "https://trader.rigoblock.com" },
      },
    });

    const client = createSmartWalletClient({
      transport,
      chain: alchemyChain,
      signer: dummySigner,
    });

    console.log(`[Wallet] Submitting signed UserOp on chain ${chainId}`);

    const result = await client.sendPreparedCalls(signedCalls);
    const callId = result.id;
    if (!callId) throw new Error("sendPreparedCalls did not return a call ID");

    console.log(`[Wallet] Submitted, callId=${callId}. Waiting for confirmation...`);
    const statusResult = await client.waitForCallsStatus({ id: callId });

    if (statusResult.status === "success" && statusResult.receipts?.length) {
      const receipt = statusResult.receipts[0];
      console.log(`[Wallet] Confirmed: ${receipt.transactionHash}`);
      return c.json({
        txHash: receipt.transactionHash,
        status: receipt.status,
      });
    }

    if (statusResult.status === "failure") {
      return c.json({ error: "Transaction reverted" }, 500);
    }

    return c.json({ error: "Status unknown", callId }, 500);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Wallet] submit-signed failed:", msg);
    return c.json({ error: `Submission failed: ${msg}` }, 500);
  }
});

/**
 * POST /api/wallet/rpc
 * Proxy RPC calls to Alchemy.
 * Body: { chainId: number, method: string, params: any[] }
 */
wallet.post("/rpc", async (c) => {
  try {
    const body = await c.req.json();
    const { chainId, method, params } = body;
    if (!chainId || !method) {
      return c.json({ error: "chainId and method required" }, 400);
    }

    if (!ALLOWED_RPC_METHODS.has(method)) {
      return c.json({ error: `Method ${method} not allowed` }, 403);
    }

    const result = await alchemyRpc(
      chainId,
      c.env.ALCHEMY_API_KEY,
      method,
      params || [],
    );
    return c.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});
