import { readLighterPosition, readLighterMarketInfo, readLighterAccount } from "../src/services/lighter.js";
import { readLighterTrackedMarkets } from "../src/services/lighter.js";

const VAULT = "0x7Bcea99B22Caa039ff282519d404dF38fbaC6CB8" as `0x${string}`;

const account = await readLighterAccount(19529, VAULT);
console.log("account:", account ? { collateral: (account.collateralBaseAmount / 1_000_000n).toString(), index: account.accountIndex.toString() } : null);

const tracked = await readLighterTrackedMarkets(19529, VAULT);
console.log("tracked markets:", tracked);

for (const m of tracked?.markets ?? []) {
  const pos = await readLighterPosition(19529, VAULT, m.marketId);
  const info = await readLighterMarketInfo(19529, m.marketId);
  console.log(`market ${m.marketId} (${m.symbol}):`, {
    position: pos?.position.toString(),
    entryQuote: pos?.entryQuote.toString(),
    funding: pos?.lastFundingRatePrefixSum.toString(),
    openOrders: pos?.totalOrderCount.toString(),
    tiedOrders: pos?.totalPositionTiedOrderCount.toString(),
    marginMode: pos?.marginMode,
    markPrice: info?.markPrice.toString(),
  });
  if (pos && info && pos.position !== 0n) {
    const scale = 10n ** BigInt(m.sizeDecimals + m.priceDecimals);
    const markValue = (pos.position * info.markPrice * 1_000_000n) / scale;
    const entryValue = pos.position > 0n ? pos.entryQuote : -pos.entryQuote;
    console.log(`  → markValue=${(markValue / 1_000_000n).toString()} USD, value(PnL)=${((markValue - entryValue) / 1_000_000n).toString()} USD`);
  }
}
