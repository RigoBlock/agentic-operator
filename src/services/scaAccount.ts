/**
 * sma-b (non-7702) smart-account derivation for Alchemy's Wallet API.
 *
 * Alchemy's Wallet API has no EIP-7702 mode on HyperEVM (chain 999) — verified
 * by scripts/test-hyperliquid-sponsor-policy.ts. The documented alternative is
 * the sma-b smart account: `wallet_requestAccount({signerAddress, creationHint:
 * {accountType: "sma-b"}})` returns a deterministic smart-account address
 * derived from OUR signer (the agent EOA). We keep the keys — Alchemy never
 * holds them — and `wallet_prepareCalls({from: <sma-b address>})` is accepted
 * on chain 999 (verified by scripts/test-hyperliquid-smab-flow.ts).
 *
 * Security invariant: the sma-b account is derived from the agent wallet only.
 * The operator wallet is NEVER involved in sponsorship — it only signs the
 * one-time on-chain updateDelegation grant.
 */

import type { Address } from "viem";
import { getEnv } from "./envContext.js";

const ALCHEMY_WALLET_API_ORIGIN = "https://trader.rigoblock.com";

/**
 * Derive the deterministic sma-b smart-account address for the agent EOA.
 *
 * One chain-agnostic `wallet_requestAccount` JSON-RPC call against
 * api.g.alchemy.com. Repeated calls for the same signer return the same
 * address (verified byte-identical), so the result is safe to persist in KV
 * and to target with on-chain delegation.
 *
 * Fails closed: throws an actionable error when the Alchemy key is missing or
 * the call fails — never returns a guessed address.
 */
export async function getScaAddress(
  agentAddress: Address,
  alchemyKey?: string,
): Promise<Address> {
  const key = alchemyKey ?? getEnv()?.ALCHEMY_API_KEY ?? process.env.ALCHEMY_API_KEY;
  if (!key) {
    throw new Error(
      "ALCHEMY_API_KEY is not configured. Deriving the HyperEVM sponsored agent " +
      "account requires an Alchemy API key.",
    );
  }

  const response = await fetch(`https://api.g.alchemy.com/v2/${key}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ALCHEMY_WALLET_API_ORIGIN,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "wallet_requestAccount",
      params: [{
        signerAddress: agentAddress,
        creationHint: { accountType: "sma-b" },
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`wallet_requestAccount HTTP error: ${response.status}`);
  }

  const data = (await response.json()) as {
    result?: { accountAddress?: string; address?: string };
    error?: { message?: string; code?: number };
  };

  if (data.error) {
    throw new Error(`wallet_requestAccount error: ${data.error.message || data.error.code}`);
  }

  const scaAddress = data.result?.accountAddress ?? data.result?.address;
  if (!scaAddress || !/^0x[0-9a-fA-F]{40}$/.test(scaAddress)) {
    throw new Error("wallet_requestAccount returned no account address");
  }

  return scaAddress as Address;
}
