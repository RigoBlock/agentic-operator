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
): Promise<SponsoredCallsResult> {
  try {
    // ── Step 1: Create signer (per SDK quickstart) ──
    console.log(`[SmartWallet] Step 1: Creating LocalAccountSigner for ${agentAccount.address}`);
    const signer = new LocalAccountSigner(agentAccount);
    const signerAddress = await signer.getAddress();
    console.log(`[SmartWallet] Step 1 OK: signerAddress=${signerAddress}`);

    // ── Step 2: Create smart wallet client (per SDK quickstart) ──
    console.log(`[SmartWallet] Step 2: Creating SmartWalletClient for chain ${chainId}`);
    const alchemyChain = getAlchemyChain(chainId);
    console.log(`[SmartWallet] Step 2a: Got Alchemy chain: ${alchemyChain.name} (id=${alchemyChain.id})`);
    const transport = alchemy({
      apiKey: alchemyKey,
      fetchOptions: {
        headers: {
          Origin: "https://trader.rigoblock.com",
        },
      },
    });
    console.log(`[SmartWallet] Step 2b: Created alchemy transport (with Origin header)`);

    const client = createSmartWalletClient({
      transport,
      chain: alchemyChain,
      signer,
    });
    console.log(`[SmartWallet] Step 2 OK: Client created`);

    // ── Step 3: Prepare calls ──
    console.log(
      `[SmartWallet] Step 3: prepareCalls: ${calls.length} call(s), ` +
      `from=${signerAddress}, policyId=${policyId}` +
      (callGasLimit ? `, callGasLimit=${callGasLimit}` : ""),
    );
    const capabilities: Record<string, unknown> = {
      paymasterService: {
        policyId,
      },
    };
    if (callGasLimit) {
      capabilities.gasParamsOverride = {
        callGasLimit: `0x${callGasLimit.toString(16)}`,
      };
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
    console.log(`[SmartWallet] Step 3 OK: Calls prepared`);

    // ── Step 4: Sign the prepared calls ──
    console.log(`[SmartWallet] Step 4: signPreparedCalls...`);
    const signedCalls = await client.signPreparedCalls(preparedCalls);
    console.log(`[SmartWallet] Step 4 OK: Calls signed`);

    // ── Step 5: Send the prepared calls ──
    console.log(`[SmartWallet] Step 5: sendPreparedCalls...`);
    const result = await client.sendPreparedCalls(signedCalls);

    const callId = result.id;
    if (!callId) {
      throw new Error("sendPreparedCalls did not return a call ID");
    }
    console.log(`[SmartWallet] Step 5 OK: callId=${callId}`);

    // ── Step 6: Wait for confirmation ──
    console.log(`[SmartWallet] Step 6: waitForCallsStatus...`);
    const statusResult = await client.waitForCallsStatus({ id: callId });

    console.log(
      `[SmartWallet] Step 6 OK: status=${statusResult.status} ` +
      `(receipts: ${statusResult.receipts?.length ?? 0})`,
    );

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
    console.error(`[SmartWallet] FAILED: ${errMsg}`);
    if (errDetails) console.error(`[SmartWallet] Details: ${errDetails}`);
    if (errCode) console.error(`[SmartWallet] Code: ${errCode}`);
    if (errStack) console.error(`[SmartWallet] Stack: ${errStack}`);
    // Re-throw with the original error for the caller to handle
    throw err;
  }
}
