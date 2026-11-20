/**
 * Billing Service — x402 auto-pay deposits.
 *
 * Each operator gets a deterministic CDP Server Wallet (TEE-backed keys,
 * managed exactly like the vault agent wallets) used ONLY as a USDC deposit
 * for API payments. The operator tops it up once; the worker signs standard
 * x402 payment payloads (USDC EIP-3009 TransferWithAuthorization) from it per
 * call. Chat uses the upto scheme (Permit2 witness, billed by actual cost);
 * its facilitatorAddress comes from the CDP facilitator's /supported document,
 * pinned in KV so it is static across isolates (see services/cdpFacilitator.ts).
 *
 * This is NOT a payment bypass: the facilitator verifies and settles a normal
 * x402 payment signature on every call — the deposit is only the funding
 * source. Hard guarantees, enforced in code:
 *   - payments sign ONLY to the hardcoded PAY_TO recipient;
 *   - amounts come ONLY from PROTECTED_ROUTES config (never client-supplied);
 *   - USDC on Base only; validBefore ≤ the scheme's 300s window;
 *   - withdrawals authorize ONLY the session-authenticated operator address.
 */

import { encodeFunctionData, type Address } from "viem";
import { toAccount } from "viem/accounts";
import type { LocalAccount } from "viem/accounts";
import { CdpClient } from "@coinbase/cdp-sdk";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import type { Env } from "../types.js";
import { ERC20_ABI } from "../abi/erc20.js";
import { getRpcProvider } from "./rpcClient.js";
import { PAY_TO, getRoutePaymentRequirements } from "../middleware/x402.js";

/** USDC on Base mainnet — the only billing asset. */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_CHAIN_ID = 8453;
const PAYMENT_WINDOW_SEC = 300; // matches the x402 scheme default maxTimeoutSeconds

export class BillingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BillingError";
    this.code = code;
  }
}

function getCdpClient(env: Env): CdpClient {
  return new CdpClient({
    apiKeyId: env.CDP_API_KEY_ID,
    apiKeySecret: env.CDP_API_KEY_SECRET,
    walletSecret: env.CDP_WALLET_SECRET,
  });
}

/** CDP account name for an operator's billing wallet — deterministic, idempotent. */
function billingAccountName(operatorAddress: string): string {
  // CDP naming rules: alphanumeric + hyphens only, 2–36 chars ("bill-" + 30 hex).
  return `bill-${operatorAddress.toLowerCase().slice(2, 32)}`;
}

/** The operator's billing wallet address (created lazily via CDP). */
export async function getBillingWalletAddress(env: Env, operatorAddress: string): Promise<Address> {
  const cdp = getCdpClient(env);
  const account = await cdp.evm.getOrCreateAccount({ name: billingAccountName(operatorAddress) });
  return account.address as Address;
}

/** Load the billing wallet as a signing account (CDP Server Wallet, TEE-backed). */
async function loadBillingAccount(env: Env, operatorAddress: string): Promise<LocalAccount> {
  const address = await getBillingWalletAddress(env, operatorAddress);
  const cdp = getCdpClient(env);
  const cdpAccount = await cdp.evm.getAccount({ address });
  return toAccount(cdpAccount as unknown as LocalAccount);
}

/** USDC balance (base units) of the operator's billing wallet on Base. */
export async function getBillingBalance(env: Env, operatorAddress: string): Promise<bigint> {
  const address = await getBillingWalletAddress(env, operatorAddress);
  const client = getRpcProvider(BASE_CHAIN_ID);
  const balance = await client.readContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
    blockTag: "latest",
  } as any);
  return BigInt(balance as bigint);
}

/** "$0.0020" → 2000n (USDC has 6 decimals on Base). */
export function priceToAmount(price: string): bigint {
  const match = price.match(/\$?([0-9]+(?:\.[0-9]+)?)/);
  if (!match) throw new BillingError("invalid_config", `Cannot parse price "${price}"`);
  const [whole, frac = ""] = match[1].split(".");
  return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6) || "0");
}

interface BillingRequirements {
  scheme: "exact" | "upto";
  network: string;
  amount: bigint; // micro-USDC (exact price, or upto max)
  payTo: Address;
  asset: Address;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
  /** Exact requirement object from the server pipeline, echoed as `accepted`. */
  accepted: Record<string, unknown>;
  /** Server-declared resource metadata and extensions echoed by x402 clients. */
  resource: Record<string, unknown>;
  extensions: Record<string, unknown>;
}

/**
 * Resolve the payment terms for a protected route from the x402 resource
 * server's OWN requirement pipeline — the same enriched accepts a 402
 * response carries. Signing against these guarantees the deposit-signed
 * payment matches what findMatchingRequirements validates (facilitator
 * metadata included). Hard safety checks keep the operator terms
 * server-enforced: payTo/asset must match the constants and the amount must
 * be within the known PROTECTED_ROUTES price bounds.
 */
export async function getRouteRequirements(
  env: Env,
  method: string,
  pathname: string,
): Promise<BillingRequirements> {
  let accepts: Array<Record<string, unknown>>;
  let resource: Record<string, unknown>;
  let extensions: Record<string, unknown>;
  try {
    ({ accepts, resource, extensions } = await getRoutePaymentRequirements(env, method, pathname));
  } catch (err) {
    if (err instanceof BillingError) throw err;
    const e = err as Error & { code?: string };
    throw new BillingError(e.code || "unknown_route", e.message);
  }
  const accept = accepts.find((a) => a.scheme === "upto") || accepts[0];
  const scheme = accept.scheme as "exact" | "upto";
  const payTo = String(accept.payTo).toLowerCase();
  const asset = String(accept.asset).toLowerCase();
  if (payTo !== PAY_TO.toLowerCase()) {
    throw new BillingError("invalid_config", `Route pays to unexpected address ${payTo}`);
  }
  if (asset !== USDC_BASE.toLowerCase()) {
    throw new BillingError("invalid_config", `Route uses unexpected asset ${asset}`);
  }
  const amount = BigInt(String(accept.amount));
  // Bound sanity: no protected route costs more than the $0.20 chat max.
  if (amount <= 0n || amount > 200_000n) {
    throw new BillingError("invalid_config", `Route amount ${amount} is out of bounds`);
  }
  return {
    scheme,
    network: String(accept.network),
    amount,
    payTo: accept.payTo as Address,
    asset: accept.asset as Address,
    maxTimeoutSeconds: Number(accept.maxTimeoutSeconds) || PAYMENT_WINDOW_SEC,
    extra: (accept.extra as Record<string, unknown>) || {},
    accepted: accept,
    resource,
    extensions,
  };
}

function randomBytes32(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return (`0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`) as `0x${string}`;
}

function base64EncodeJson(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Sign an x402 payment for a protected route from the operator's deposit.
 * The SDK builds the complete payment envelope: accepted requirements,
 * resource metadata, extension merging, Permit2 authorization, and EIP-2612
 * gas sponsorship. We only provide the CDP-backed signer and route terms.
 *
 * Throws BillingError("insufficient_deposit") when the balance cannot cover
 * the route's amount.
 */
export async function signBillingPayment(
  env: Env,
  operatorAddress: string,
  method: string,
  pathname: string,
): Promise<{ paymentSignature: string; amountUSDC: string }> {
  const requirements = await getRouteRequirements(env, method, pathname);
  const balance = await getBillingBalance(env, operatorAddress);
  if (balance < requirements.amount) {
    throw new BillingError(
      "insufficient_deposit",
      `Deposit balance (${balance}) is below the required amount (${requirements.amount} micro-USDC)`,
    );
  }

  const account = await loadBillingAccount(env, operatorAddress);
  // Give the SDK schemes the same RPC client used by the rest of the worker.
  // This is required for allowance/nonce reads and keeps tests hermetic.
  const signer = Object.assign(account, {
    readContract: (args: unknown) => getRpcProvider(BASE_CHAIN_ID).readContract(args as any),
  });
  const client = new x402Client()
    .register(requirements.network as `${string}:${string}`, new ExactEvmScheme(signer as any))
    .register(requirements.network as `${string}:${string}`, new UptoEvmScheme(signer as any));

  const paymentPayload = await client.createPaymentPayload({
    x402Version: 2,
    resource: requirements.resource,
    accepts: [requirements.accepted],
    extensions: requirements.extensions,
  } as any);

  return {
    paymentSignature: base64EncodeJson(paymentPayload),
    amountUSDC: (Number(requirements.amount) / 1e6).toFixed(6),
  };
}

/**
 * Build a USDC transfer-with-authorization that moves `amount` (or the full
 * balance when unspecified) from the billing wallet back to the operator.
 * Returns ready-to-submit transaction params — the operator broadcasts it
 * with their own wallet (they pay gas to receive their funds).
 */
export async function buildWithdrawal(
  env: Env,
  operatorAddress: string,
  amount?: bigint,
): Promise<{ to: Address; data: `0x${string}`; amountUSDC: string }> {
  const target = operatorAddress.toLowerCase();
  const account = await loadBillingAccount(env, operatorAddress);
  if (account.address.toLowerCase() === target) {
    throw new BillingError("invalid_request", "Cannot withdraw to the billing wallet itself");
  }
  const balance = await getBillingBalance(env, operatorAddress);
  const value = amount ?? balance;
  if (value <= 0n) throw new BillingError("insufficient_deposit", "Nothing to withdraw");
  if (value > balance) {
    throw new BillingError("insufficient_deposit", `Withdrawal exceeds the deposit balance (${balance})`);
  }

  const validBefore = Math.floor(Date.now() / 1000) + PAYMENT_WINDOW_SEC;
  const authorization = {
    from: account.address,
    to: operatorAddress as Address,
    value: value.toString(),
    validAfter: "0",
    validBefore: validBefore.toString(),
    nonce: randomBytes32(),
  };
  const signature = await account.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: BASE_CHAIN_ID, verifyingContract: USDC_BASE },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  } as any);

  const data = encodeFunctionData({
    abi: [
      {
        name: "transferWithAuthorization",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
          { name: "signature", type: "bytes" },
        ],
        outputs: [],
      },
    ] as const,
    functionName: "transferWithAuthorization",
    args: [
      authorization.from,
      authorization.to,
      BigInt(authorization.value),
      BigInt(authorization.validAfter),
      BigInt(authorization.validBefore),
      authorization.nonce,
      signature,
    ],
  });

  return { to: USDC_BASE, data, amountUSDC: (Number(value) / 1e6).toFixed(6) };
}

/** Encode a plain ERC-20 transfer for the UI's one-click top-up. */
export function buildTopUpData(depositAddress: Address, amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [depositAddress, amount],
  });
}
