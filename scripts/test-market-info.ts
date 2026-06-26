import { createGmxSdk } from "../src/services/gmxSdk.js";

async function main() {
  const sdk = createGmxSdk();
  const { marketsInfoData, tokensData } = await sdk.markets.getMarketsInfo();
  for (const [addr, m] of Object.entries(marketsInfoData ?? {})) {
    if (addr.toLowerCase() === "0x47c031236e19d024b42f8AE6780E44A573170703".toLowerCase() ||
        addr.toLowerCase() === "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336".toLowerCase()) {
      console.log(addr, {
        name: m.name,
        isSpotOnly: m.isSpotOnly,
        indexSymbol: tokensData?.[m.indexTokenAddress]?.symbol,
      });
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
