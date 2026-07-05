/**
 * Alchemy Smart Wallet integration — gas-sponsored execution via EIP-7702.
 *
 * Implements the EXACT flow from the Alchemy SDK quickstart:
 *   https://www.alchemy.com/docs/wallets/smart-wallet-quickstart/sdk
 *
 * Steps:
 *   1. Create a LocalAccountSigner via privateKeyToAccountSigner(PRIVATE_KEY)
 *   2. Create a SmartWalletClient with alchemy() transport + infra chain
 *   3. client.prepareCalls()       — builds the UserOp, auto-detects 7702
 *   4. client.signPreparedCalls()  — signs 7702 auth + UserOp
 *   5. client.sendPreparedCalls()  — submits to bundler
 *   6. client.waitForCallsStatus() — polls until confirmed
 *
 * EIP-7702 delegation is AUTOMATIC when `from` is the signer address.
 * Gas sponsorship is via `paymasterService` in capabilities.
 */

import {
  type Address,
  type Hex,
  type Chain,
} from "viem";
import type { LocalAccount } from "viem/accounts";
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
import { getAlchemyNetworkSlug } from "../config.js";

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

function getAlchemyChain(chainId: number): Chain {
  const chain = ALCHEMY_CHAIN_MAP[chainId];
  if (chain) return chain;
  throw new Error(
    `Chain ${chainId} is not supported for sponsored execution — ` +
    `no Alchemy chain definition available.`,
  );
}

/**
 * Per-chain timeout for `wallet_getCallsStatus` polling.
 * Mainnet can take up to ~1 minute during congestion. L2s should land in
 * seconds, so we fail fast and surface the callId instead of burning most of
 * the 3-minute Alchemy Policy Expiry waiting for a stuck status response.
 */
const WAIT_FOR_CALLS_STATUS_TIMEOUT_MS: Record<number, number> = {
  1: 60_000,        // Ethereum mainnet
  11155111: 60_000, // Sepolia
  // L2s / sidechains — fail fast if status cannot be retrieved
  10: 20_000,       // Optimism
  56: 20_000,       // BNB Chain
  130: 20_000,      // Unichain
  137: 20_000,      // Polygon
  8453: 20_000,     // Base
  42161: 20_000,    // Arbitrum
  84532: 20_000,    // Base Sepolia
};

function getWaitForCallsStatusTimeout(chainId: number): number {
  return WAIT_FOR_CALLS_STATUS_TIMEOUT_MS[chainId] ?? 20_000;
}

// ── Types ────────────────────────────────────────────────────────────

export interface WalletCall {
  to: Address;
  value?: Hex;
  data?: Hex;
}

export interface SponsoredCallsResult {
  callId: string;
  status: "success" | "failure" | "pending" | undefined;
  receipts?: Array<{
    transactionHash: Hex;
    blockHash: Hex;
    blockNumber: bigint;
    gasUsed: bigint;
    status: "success" | "reverted";
    logs: Array<{ address: Hex; data: Hex; topics: Hex[] }>;
  }>;
}

// ── Execute Sponsored Calls ──────────────────────────────────────────

/**
 * Execute gas-sponsored calls via Alchemy Smart Wallet.
 *
 * Follows the exact SDK quickstart flow:
 *   1. Create signer via LocalAccountSigner
 *   2. Create client via createSmartWalletClient
 *   3. prepareCalls()        — build UserOp + detect 7702 delegation
 *   4. signPreparedCalls()   — sign authorization + UserOp
 *   5. sendPreparedCalls()   — submit to bundler
 *   6. waitForCallsStatus()  — poll for confirmation
 */
export async function executeSponsoredCalls(
  agentAccount: LocalAccount,
  chainId: number,
  alchemyKey: string,
  policyId: string,
  calls: WalletCall[],
  callGasLimit?: bigint,
  maxFeePerGas?: bigint,
  maxPriorityFeePerGas?: bigint,
): Promise<SponsoredCallsResult> {
  try {
    // ── Step 1: Create signer (per SDK quickstart) ──
    const signer = new LocalAccountSigner(agentAccount);
    const signerAddress = await signer.getAddress();

    // ── Step 2: Create smart wallet client (per SDK quickstart) ──
    const alchemyChain = getAlchemyChain(chainId);
    // Route chain-agnostic wallet API calls (prepareCalls, sendPreparedCalls,
    // getCallsStatus) to the chain-specific Alchemy endpoint instead of the
    // generic api.g.alchemy.com. This fixes "Unknown network" logs and avoids
    // cross-region routing that caused Arbitrum status polling timeouts.
    const alchemyNetworkUrl = `https://${getAlchemyNetworkSlug(chainId)}.g.alchemy.com/v2`;
    const transport = alchemy({
      apiKey: alchemyKey,
      chainAgnosticUrl: alchemyNetworkUrl,
      fetchOptions: {
        headers: {
          Origin: "https://trader.rigoblock.com",
        },
      },
    });

    const client = createSmartWalletClient({
      transport,
      chain: alchemyChain,
      signer,
    });

    // ── Step 3: Prepare calls ──
    const capabilities: Record<string, unknown> = {
      paymasterService: {
        policyId,
      },
    };
    const gasOverrides: Record<string, string> = {};
    if (callGasLimit) {
      gasOverrides.callGasLimit = `0x${callGasLimit.toString(16)}`;
    }
    if (maxFeePerGas) {
      gasOverrides.maxFeePerGas = `0x${maxFeePerGas.toString(16)}`;
    }
    if (maxPriorityFeePerGas) {
      gasOverrides.maxPriorityFeePerGas = `0x${maxPriorityFeePerGas.toString(16)}`;
    }
    if (Object.keys(gasOverrides).length > 0) {
      capabilities.gasParamsOverride = gasOverrides;
    }
    const preparedCalls = await client.prepareCalls({
      calls: calls.map(c => ({
        to: c.to,
        data: c.data || ("0x" as Hex),
        value: c.value || ("0x0" as Hex),
      })),
      from: signerAddress,
      capabilities,
    });

    // ── Step 4: Sign the prepared calls ──
    const signedCalls = await client.signPreparedCalls(preparedCalls);

    // ── Step 5: Send the prepared calls ──
    const result = await client.sendPreparedCalls(signedCalls);

    const callId = result.id;
    if (!callId) {
      throw new Error("sendPreparedCalls did not return a call ID");
    }

    // ── Step 6: Wait for confirmation ──
    // Use a longer timeout (90s) and explicit polling so transient Alchemy
    // latency does not immediately kill the request. If the status still cannot
    // be determined, return a pending result with the callId so the caller can
    // surface "submitted but not yet confirmed" instead of hanging forever.
    let statusResult;
    try {
      statusResult = await client.waitForCallsStatus({
        id: callId,
        pollingInterval: 4_000,
        timeout: getWaitForCallsStatusTimeout(chainId),
      });
    } catch (waitErr) {
      const isTimeout =
        (waitErr instanceof Error && waitErr.name === "WaitForCallsStatusTimeoutError") ||
        String(waitErr).includes("Timed out while waiting for call bundle");
      if (isTimeout) {
        console.warn(
          `[bundler] waitForCallsStatus timed out for chain ${chainId}, callId ${callId}. ` +
            "Returning pending result so the caller can surface the callId to the user.",
        );
        return {
          callId,
          status: "pending" as const,
          receipts: undefined,
        };
      }
      throw waitErr;
    }



    return {
      callId,
      status: statusResult.status,
      receipts: statusResult.receipts as SponsoredCallsResult["receipts"],
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    // Log full error details for debugging bundler/paymaster failures
    const errDetails = (err as any)?.details || (err as any)?.cause?.message || "";
    const errCode = (err as any)?.code || (err as any)?.cause?.code || "";
    // Re-throw with the original error for the caller to handle
    throw err;
  }
}

/**
 * Query the status of a previously submitted sponsored call bundle.
 * Returns the EVM receipts if the bundle has landed on-chain, or a pending
 * status if it is still in the bundler mempool.
 *
 * This is used by the pending-transaction poller: when a sponsored tx times
 * out before `waitForCallsStatus()` can return a receipt, we only have the
 * callId (UserOp hash). Calling `wallet_getCallsStatus` lets us map that
 * callId to the actual EVM transaction hash once it lands.
 */
export async function getSponsoredCallsStatus(
  callId: string,
  chainId: number,
  alchemyKey: string,
): Promise<SponsoredCallsResult> {
  const alchemyNetworkUrl = `https://${getAlchemyNetworkSlug(chainId)}.g.alchemy.com/v2/${alchemyKey}`;

  const response = await fetch(alchemyNetworkUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://trader.rigoblock.com",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "wallet_getCallsStatus",
      params: [{ id: callId }],
    }),
  });

  if (!response.ok) {
    throw new Error(`wallet_getCallsStatus HTTP error: ${response.status}`);
  }

  const data = (await response.json()) as {
    result?: {
      id?: string;
      status?: "success" | "failure" | "pending";
      receipts?: Array<{
        transactionHash: Hex;
        blockHash: Hex;
        blockNumber: bigint;
        gasUsed: bigint;
        status: "success" | "reverted";
        logs: Array<{ address: Hex; data: Hex; topics: Hex[] }>;
      }>;
    };
    error?: { message?: string; code?: number };
  };

  if (data.error) {
    throw new Error(`wallet_getCallsStatus error: ${data.error.message || data.error.code}`);
  }

  const result = data.result;
  if (!result) {
    throw new Error("wallet_getCallsStatus returned empty result");
  }

  return {
    callId: result.id || callId,
    status: result.status,
    receipts: result.receipts as SponsoredCallsResult["receipts"],
  };
}
