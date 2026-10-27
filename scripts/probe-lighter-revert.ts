/**
 * One-off probe: reproduce the Oct 27 `lighter_limit_order` revert and exercise
 * the deposit/withdraw simulation path against the live Lighter devnet RPC.
 * Run: LIGHTER_RPC_URL=https://evm-rpc.devnet.lighterevm.axiom.xyz npx tsx scripts/probe-lighter-revert.ts
 */
import { createPublicClient, http, encodeFunctionData } from "viem";
import { buildLighterDepositCalldata, buildLighterOrderCalldata, buildLighterWithdrawCalldata } from "../src/services/lighterTrading.js";
import { readLighterAccount, readLighterMarketInfo } from "../src/services/lighter.js";
import { RIGOBLOCK_VAULT_ABI } from "../src/abi/rigoblockVault.js";

const RPC = process.env.LIGHTER_RPC_URL ?? "https://evm-rpc.devnet.lighterevm.axiom.xyz";
const VAULT = (process.env.VAULT ?? "0x07816c517ccF14C64c7De3AeF88d638F12c1C9Be") as `0x${string}`;
const OWNER = "0x000f05552f24850e75793d38c2bd0cbd249a9ff4" as `0x${string}`; // operator (vault owner)

const chain = {
  id: 19529,
  name: "Lighter Devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const client = createPublicClient({ chain, transport: http(RPC, { timeout: 15_000, retryCount: 0 }) });

async function simulate(label: string, data: `0x${string}`, from: `0x${string}` = OWNER) {
  try {
    const r = await client.call({ account: from, to: VAULT, data, blockTag: "latest" });
    console.log(`${label}: OK${r.data && r.data !== "0x" ? ` data=${r.data.slice(0, 66)}` : ""}`);
  } catch (e: any) {
    console.log(`${label}: REVERTED`);
    console.log(`  shortMessage: ${e.shortMessage ?? e.message}`);
    const meta = e.metaMessages ?? e.details ?? e.cause?.message;
    if (meta) console.log(`  details: ${JSON.stringify(meta).slice(0, 500)}`);
    const raw = e.data ?? e.cause?.data;
    if (typeof raw === "string") console.log(`  revertData: ${raw.slice(0, 200)}`);
  }
}

const updateNav = encodeFunctionData({ abi: RIGOBLOCK_VAULT_ABI, functionName: "updateUnitaryValue" });

// 0. Environment sanity
console.log("chainId:", await client.getChainId());
console.log("block:", await client.getBlockNumber());

// 1. Core account state for the vault (post-reset)
const acct = await readLighterAccount(19529, VAULT);
console.log("\nCore account:", JSON.stringify(acct, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

// 2. Market 0 info
const mkt = await readLighterMarketInfo(19529, 0);
console.log("\nMarket 0:", JSON.stringify(mkt, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

// 3. The exact failing order: SELL 0.04 ETH @ 2600 (vault 0x0781...)
const built = await buildLighterOrderCalldata({
  chainId: 19529,
  vault: VAULT,
  marketId: 0,
  side: "sell",
  sizeHuman: "0.04",
  priceHuman: "2600",
  isMarket: false,
});
console.log("\norder calldata:", built.calldata.slice(0, 20), "...");
await simulate("createOrder(SELL 0.04 ETH @2600)", built.calldata);

// 4. NAV shield composition: multicall([order, updateUnitaryValue]) from owner
const multicall = encodeFunctionData({
  abi: RIGOBLOCK_VAULT_ABI,
  functionName: "multicall",
  args: [[built.calldata, updateNav]],
});
await simulate("multicall([order, updateNav])", multicall);

// 5. Deposit path: sendToCore + NAV-neutral raw-tx simulation + estimateGas
const dep = buildLighterDepositCalldata(VAULT, "10");
await simulate("sendToCore(10 USDC)", dep);
await simulate("updateUnitaryValue (pre-nav read)", updateNav);
try {
  const gas = await client.estimateGas({ account: OWNER, to: VAULT, data: dep, blockTag: "latest" });
  console.log("estimateGas(sendToCore):", gas);
} catch (e: any) {
  console.log("estimateGas(sendToCore) failed:", e.shortMessage ?? e.message);
}
const fees = await client.estimateFeesPerGas();
console.log("estimateFeesPerGas:", JSON.stringify(fees, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

// 6. Withdraw path
const wd = buildLighterWithdrawCalldata(VAULT, "5");
await simulate("sendToEvm(5 USDC)", wd);
