/**
 * Debug: simulate the exact depositV3 calldata the crosschain_transfer tool
 * builds for HyperEVM (999) → Base (8453) and surface the real revert reason.
 *
 * Usage: yarn tsx scripts/debug-crosschain-transfer.ts
 */
import { encodeFunctionData, encodeAbiParameters, parseAbiParameters, decodeErrorResult } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../src/abi/rigoblockVault.js";

const RPC = "https://rpc.hyperliquid.xyz/evm";
const OPERATOR = "0xcA9F5049c1Ea8FC78574f94B7Cf5bE5fEE354C31";
const VAULT = "0xefa4bdf566ae50537a507863612638680420645c";
const INPUT = "0xb88339CB7199b77E23DB6E890353E22632Ba630f"; // HyperEVM USDC
const OUTPUT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC
const AMOUNT = 5_000_000n; // 5 USDC (6 decimals)
const FILL_DEADLINE_SECS = 6 * 60 * 60;
const NAV_TOLERANCE_BPS = 100;
const OP_TRANSFER = 0;

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

async function main() {
  // 1. Fresh Across quote
  const feesUrl = new URL("https://app.across.to/api/suggested-fees");
  feesUrl.searchParams.set("inputToken", INPUT);
  feesUrl.searchParams.set("outputToken", OUTPUT);
  feesUrl.searchParams.set("originChainId", "999");
  feesUrl.searchParams.set("destinationChainId", "8453");
  feesUrl.searchParams.set("amount", AMOUNT.toString());
  const fees = await (await fetch(feesUrl)).json() as {
    timestamp: string; outputAmount: string; exclusiveRelayer: `0x${string}`;
    exclusivityDeadline: string; totalRelayFee: { total: string };
  };
  console.log("Across quote timestamp:", fees.timestamp, "relayFee:", fees.totalRelayFee.total);
  const quoteTimestamp = Number(fees.timestamp);
  const outputAmount = BigInt(fees.outputAmount);
  const exclusiveRelayer = fees.exclusiveRelayer as `0x${string}`;
  const exclusivityDeadline = Number(fees.exclusivityDeadline);

  // 2. Build calldata exactly like buildDepositV3Calldata
  const message = encodeAbiParameters(
    parseAbiParameters("uint8, uint256, uint256, bool"),
    [OP_TRANSFER, BigInt(NAV_TOLERANCE_BPS), 0n, false],
  );
  const calldata = encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "depositV3",
    args: [{
      depositor: VAULT,
      recipient: VAULT,
      inputToken: INPUT,
      outputToken: OUTPUT,
      inputAmount: AMOUNT,
      outputAmount,
      destinationChainId: 8453n,
      exclusiveRelayer,
      quoteTimestamp,
      fillDeadline: quoteTimestamp + FILL_DEADLINE_SECS,
      exclusivityDeadline,
      message,
    }],
  });
  console.log("calldata:", calldata);

  // 3. eth_call from operator
  const call = await rpc("eth_call", [{ from: OPERATOR, to: VAULT, data: calldata }, "latest"]);
  console.log("\neth_call (operator):", JSON.stringify(call).slice(0, 300));

  // 3b. estimateGas from operator vs unauthorized sender — the vault must
  // authorize the executor, otherwise on-chain execution reverts.
  const STRANGER = "0xdEaD00000000000000000000000000000000bEEF";
  console.log("\nestimateGas (operator):", JSON.stringify(await rpc("eth_estimateGas", [{ from: OPERATOR, to: VAULT, data: calldata }, "latest"])).slice(0, 200));
  console.log("estimateGas (stranger):", JSON.stringify(await rpc("eth_estimateGas", [{ from: STRANGER, to: VAULT, data: calldata }, "latest"])).slice(0, 400));
  console.log("eth_call (stranger):", JSON.stringify(await rpc("eth_call", [{ from: STRANGER, to: VAULT, data: calldata }, "latest"])).slice(0, 400));

  // 4. debug_traceCall to find deepest revert
  const trace = await rpc("debug_traceCall", [
    { from: OPERATOR, to: VAULT, data: calldata },
    "latest",
    { tracer: "callTracer", tracerConfig: { withLog: false } },
  ]);
  if (trace.error) {
    console.log("\ntrace error:", trace.error.message);
  }
  if (trace.result) {
    const failures: any[] = [];
    const walk = (f: any, depth: number) => {
      if (f.error) failures.push({ depth, to: f.to, input: f.input?.slice(0, 10), error: f.error, output: f.output });
      for (const c of f.calls ?? []) walk(c, depth + 1);
    };
    walk(trace.result, 0);
    console.log(`\nreverting frames: ${failures.length}`);
    for (const f of failures.slice(0, 10)) {
      console.log("─".repeat(60));
      console.log("to:", f.to, "selector:", f.input);
      console.log("error:", f.error);
      if (f.output && f.output.length >= 10) {
        try {
          const decoded = decodeErrorResult({
            abi: [
              { name: "Error", type: "error", inputs: [{ name: "message", type: "string" }] },
              { name: "Panic", type: "error", inputs: [{ name: "code", type: "uint256" }] },
            ],
            data: f.output,
          });
          console.log("decoded:", decoded.errorName, ...(decoded.args as readonly unknown[]));
        } catch {
          console.log("raw output:", f.output.slice(0, 200));
        }
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
