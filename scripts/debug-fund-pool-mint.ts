/**
 * Repro for the fund_pool step-2 (mint) 500 on Lighter Devnet.
 * Runs the exact server path: handler reads → NAV shield → prepareTransaction,
 * plus the shield-disabled variant. No auth/HTTP — pure service calls.
 */
import { getRpcProvider } from "../src/services/rpcClient.js";
import { getNavData, encodeMint } from "../src/services/vault.js";
import { checkNavImpact } from "../src/services/navGuard.js";
import { prepareTransaction } from "../src/services/transactionPrepare.js";
import { ERC20_ABI } from "../src/abi/erc20.js";
import type { Env } from "../src/types.js";
import type { Address } from "viem";

const CHAIN = 19529;
const VAULT = "0x7Bcea99B22Caa039ff282519d404dF38fbaC6CB8" as Address;
const OP = "0x000f05552f24850e75793d38c2bd0cbd249a9ff4" as Address;
const USDC = "0xf2A5728d366c6d0f764Af612cD47F3608E2B4d5B" as Address;
const AMOUNT = 40n * 10n ** 6n; // 40 USDC

function show(label: string, fn: () => Promise<unknown>) {
  return fn().then(
    (r) => console.log(`\n=== ${label}: OK ===`, typeof r === "object" ? JSON.stringify(r, (_, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 600) : r),
    (e) => console.log(`\n=== ${label}: THREW ===\n${e?.stack || e}`),
  );
}

async function main() {
  const client = getRpcProvider(CHAIN);

  await show("allowance(OP, VAULT)", () =>
    client.readContract({ address: USDC, abi: ERC20_ABI, functionName: "allowance", args: [OP, VAULT] }));

  await show("getNavData (updateUnitaryValue sim)", () => getNavData(CHAIN, VAULT));

  const mintData = encodeMint(OP, AMOUNT, 0n);
  console.log("\nmint calldata:", mintData.slice(0, 20), "…");

  await show("checkNavImpact FULL shield (multicall [mint, update])", () =>
    checkNavImpact(VAULT, mintData, 0n, CHAIN, OP));

  await show("checkNavImpact DISABLED (maxDropPct=0)", () =>
    checkNavImpact(VAULT, mintData, 0n, CHAIN, OP, undefined, 0n));

  await show("estimateGas mint from OP @latest", () =>
    client.estimateGas({ account: OP, to: VAULT, data: mintData, value: 0n, blockTag: "latest" }));

  const ctx = {
    vaultAddress: VAULT, chainId: CHAIN, operatorAddress: OP,
    operatorVerified: true, executionMode: "manual" as const,
  };
  await show("prepareTransaction (full tools-route path)", () =>
    prepareTransaction({} as Env, ctx, {
      to: VAULT, data: mintData, value: "0x0", chainId: CHAIN,
      description: "Fund pool: deposit 40 USDC", operatorOnly: true,
    }));
}

main().catch((e) => { console.error(e); process.exit(1); });
