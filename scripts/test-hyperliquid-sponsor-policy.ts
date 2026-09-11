/**
 * Probe: does Alchemy HyperEVM Wallet API accept EIP-7702 prepareCalls now
 * that the operator added HyperEVM to the Gas Manager policy?
 *
 * Mirrors src/services/bundler.ts executeSponsoredCalls exactly (same client,
 * same transport + Origin header, same prepareCalls params), with a junk
 * signer and a dummy policy id. Read-only: prepareCalls only estimates.
 *
 *   npx tsx scripts/test-hyperliquid-sponsor-policy.ts
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Chain } from "viem";
import { LocalAccountSigner } from "@aa-sdk/core";
import { createSmartWalletClient } from "@account-kit/wallet-client";
import {
  alchemy,
  base as alchemyBase,
  hyperliquid as alchemyHyperliquid,
} from "@account-kit/infra";
import { readFileSync } from "node:fs";

const alchemyKey = readFileSync(".dev.vars", "utf-8")
  .split("\n")
  .find((l) => l.startsWith("ALCHEMY_API_KEY="))!
  .split("=")[1]
  .trim();

const DUMMY_POLICY = "00000000-0000-0000-0000-000000000000";

function errorChain(err: unknown): string {
  const msgs: string[] = [];
  let cur: unknown = err;
  while (cur) {
    const m = (cur as { message?: unknown }).message;
    if (m) msgs.push(String(m).slice(0, 300));
    cur = (cur as { cause?: unknown }).cause;
  }
  return msgs.join("  ||  ") || String(err);
}

async function probe(chain: Chain, chainId: number, usePaymaster: boolean): Promise<void> {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = new LocalAccountSigner(account);
  const transport = alchemy({
    apiKey: alchemyKey,
    fetchOptions: { headers: { Origin: "https://trader.rigoblock.com" } },
  });
  const client = createSmartWalletClient({ transport, chain, signer });
  const capabilities: Record<string, unknown> | undefined = usePaymaster
    ? { paymasterService: { policyId: DUMMY_POLICY } }
    : undefined;
  const tag = `[chain ${chainId} paymaster=${usePaymaster}]`;
  try {
    const prepared = await client.prepareCalls({
      calls: [{ to: account.address, data: "0x", value: "0x0" }],
      from: account.address,
      ...(capabilities ? { capabilities } : {}),
    });
    console.log(`${tag} PREPARE OK — 7702 mode accepted`, JSON.stringify(prepared).slice(0, 160));
  } catch (err) {
    console.log(`${tag} PREPARE FAIL: ${errorChain(err)}`);
  }
}

async function main() {
  // Control: Base with dummy policy — 7702 works there, so this shows what a
  // paymaster/policy-stage rejection looks like (vs the 7702-stage rejection).
  await probe(alchemyBase, 8453, true);
  // HyperEVM, no paymaster: is 7702 mode itself accepted?
  await probe(alchemyHyperliquid, 999, false);
  // HyperEVM, dummy policy: which stage rejects?
  await probe(alchemyHyperliquid, 999, true);
}

main().then(() => process.exit(0));
