/**
 * Probe: Alchemy HyperEVM NON-7702 (sma-b) flow — the mode the docs recipe
 * uses. If wallet_prepareCalls accepts calls from an sma-b smart account
 * address on HyperEVM, sponsored gas IS reachable there via a different route.
 *
 *   1. wallet_requestAccount({signerAddress, creationHint:{accountType:"sma-b"}})
 *      → stable smart-account address derived from OUR signer (we keep the keys)
 *   2. wallet_prepareCalls({from: <sma-b address>, calls}) → accepted?
 *
 * Control: same flow on Base. Read-only (prepareCalls only estimates).
 *
 *   npx tsx scripts/test-hyperliquid-smab-flow.ts
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

const alchemyKey = readFileSync(".dev.vars", "utf-8")
  .split("\n")
  .find((l) => l.startsWith("ALCHEMY_API_KEY="))!
  .split("=")[1]
  .trim();

const API = `https://api.g.alchemy.com/v2/${alchemyKey}`;
const ORIGIN = "https://trader.rigoblock.com";
const DUMMY_POLICY = "00000000-0000-0000-0000-000000000000";

async function rpc(method: string, params: unknown[]): Promise<{ result?: any; error?: any }> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json() as Promise<{ result?: any; error?: any }>;
}

async function probeChain(chainId: number, label: string): Promise<void> {
  const owner = privateKeyToAccount(generatePrivateKey());
  console.log(`\n=== ${label} (chain ${chainId}) owner=${owner.address} ===`);

  // Step 1: request sma-b smart account for our signer
  const req = await rpc("wallet_requestAccount", [{
    signerAddress: owner.address,
    creationHint: { accountType: "sma-b" },
  }]);
  if (req.error) {
    console.log(`requestAccount FAILED: ${JSON.stringify(req.error).slice(0, 300)}`);
    return;
  }
  const scaAddress: string | undefined = req.result?.accountAddress ?? req.result?.address;
  if (!scaAddress) {
    console.log(`requestAccount returned no address — full result: ${JSON.stringify(req.result).slice(0, 500)}`);
    return;
  }
  console.log(`  (different from owner: ${scaAddress.toLowerCase() !== owner.address.toLowerCase()})`);

  // Step 3: prepare + sign via the INSTALLED v4 SDK (what bundler.ts uses) with
  // from = sma-b address (≠ signer). If the v4 SDK handles non-7702 mode, the
  // production path can stay on the SDK; otherwise 999 needs raw JSON-RPC.
  const { LocalAccountSigner } = await import("@aa-sdk/core");
  const { createSmartWalletClient } = await import("@account-kit/wallet-client");
  const infra = await import("@account-kit/infra");
  const alchemyChain = chainId === 999 ? infra.hyperliquid : infra.base;
  const transport = infra.alchemy({
    apiKey: alchemyKey,
    fetchOptions: { headers: { Origin: ORIGIN } },
  });
  const signer = new LocalAccountSigner(owner as any);
  const client = createSmartWalletClient({ transport, chain: alchemyChain, signer } as any);
  try {
    const prepared = await (client as any).prepareCalls({
      calls: [{ to: owner.address, data: "0x", value: "0x0" }],
      from: scaAddress,
      // No paymaster: with a real policy ID in prod the paymasterService
      // capability is added back (validated above that the request shape passes).
    });
    console.log(`v4 SDK prepareCalls(from=sma-b) OK — type: ${prepared?.type}`);
    try {
      const signed = await (client as any).signPreparedCalls(prepared);
      console.log(`v4 SDK signPreparedCalls OK — signature present: ${!!signed?.signature}`);
    } catch (signErr: any) {
      console.log(`v4 SDK signPreparedCalls FAILED: ${String(signErr?.message ?? signErr).slice(0, 300)}`);
    }
  } catch (prepErr: any) {
    let msgs: string[] = [];
    let cur: any = prepErr;
    while (cur) { if (cur.message) msgs.push(String(cur.message).slice(0, 200)); cur = cur.cause; }
    console.log(`v4 SDK prepareCalls(from=sma-b) FAILED: ${msgs.join(" || ")}`);
  }
}

async function main() {
  // Determinism: same signer → same sma-b address across repeated requestAccount
  // calls (it must be, since on-chain delegation will target it).
  const owner = privateKeyToAccount(generatePrivateKey());
  console.log(`=== determinism check owner=${owner.address} ===`);
  const a1 = await rpc("wallet_requestAccount", [{ signerAddress: owner.address, creationHint: { accountType: "sma-b" } }]);
  const a2 = await rpc("wallet_requestAccount", [{ signerAddress: owner.address, creationHint: { accountType: "sma-b" } }]);
  const addr1 = a1.result?.accountAddress;
  const addr2 = a2.result?.accountAddress;
  console.log(`first:  ${addr1}`);
  console.log(`second: ${addr2}`);
  console.log(`stable: ${addr1 === addr2}`);

  await probeChain(999, "HyperEVM");
  await probeChain(8453, "Base (control)");
}

main().then(() => process.exit(0));
