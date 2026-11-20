/**
 * One-off probe: read the full Lighter Core state of two pools — account,
 * positions, per-market order counts, the contract's tracked-markets view
 * (lastReqId), and the Core processing status of the recent reqIds.
 * Run: LIGHTER_RPC_URL=https://evm-rpc.devnet.lighterevm.axiom.xyz npx tsx scripts/probe-lighter-core-state.ts
 */
import {
  readLighterAccount,
  readLighterPosition,
  readLighterTrackedMarkets,
  readLighterTxStatus,
  readLighterMarketInfo,
} from "../src/services/lighter.js";

const VAULTS: { name: string; address: `0x${string}` }[] = [
  { name: "0x7Bcea (tester?)", address: "0x7Bcea99B22Caa039ff282519d404dF38fbaC6CB8" },
  { name: "0x07816 (earnest?)", address: "0x07816c517ccF14C64c7De3AeF88d638F12c1C9Be" },
];

const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

for (const v of VAULTS) {
  console.log(`\n════════ ${v.name} ${v.address} ════════`);
  const [acct, tracked] = await Promise.all([
    readLighterAccount(19529, v.address),
    readLighterTrackedMarkets(19529, v.address),
  ]);
  console.log("account:", j(acct));
  console.log("tracked view:", j(tracked));

  for (const m of [0, 1, 2, 3]) {
    const [pos, info] = await Promise.all([
      readLighterPosition(19529, v.address, m),
      readLighterMarketInfo(19529, m),
    ]);
    if (pos) {
      console.log(
        `market ${m}: position=${pos.position} entryQuote=${pos.entryQuote} openOrders=${pos.totalOrderCount} tiedOrders=${pos.totalPositionTiedOrderCount} marginMode=${pos.marginMode} allocatedMargin=${pos.allocatedMargin} markPrice=${info?.markPrice}`,
      );
    } else {
      console.log(`market ${m}: no position${info ? ` (mark ${info.markPrice})` : ""}`);
    }
  }

  if (tracked) {
    const last = Number(tracked.lastReqId);
    for (let req = Math.max(0, last - 3); req <= last; req++) {
      if (req === 0) continue;
      const st = await readLighterTxStatus(19529, BigInt(req));
      console.log(`reqId ${req}:`, j(st));
    }
  }
}
