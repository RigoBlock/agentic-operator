import { createGmxSdk } from "../src/services/gmxSdk.js";
import type { Address } from "viem";

async function main() {
  const vault = (process.argv[2] || "0xEfa4bDf566aE50537A507863612638680420645C") as Address;
  console.log("Fetching positions using SDK for", vault);

  const sdk = createGmxSdk(vault);
  console.log("SDK account:", sdk.account);

  const { marketsInfoData, tokensData } = await sdk.markets.getMarketsInfo();
  console.log("Markets count:", Object.keys(marketsInfoData ?? {}).length);
  console.log("Tokens count:", Object.keys(tokensData ?? {}).length);

  const positionsInfoData = await sdk.positions.getPositionsInfo({
    marketsInfoData: marketsInfoData ?? {},
    tokensData: tokensData ?? {},
    showPnlInLeverage: true,
  });
  const positions = Object.values(positionsInfoData ?? {}).filter((p) => p.sizeInUsd > 0n);
  console.log("Positions count:", positions.length);
  console.log(JSON.stringify(positions.slice(0, 2), (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
