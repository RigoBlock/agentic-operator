import { GmxApiSdk } from "@gmx-io/sdk/v2";

const vaultAddress = process.env.VAULT_ADDRESS || "0xEfa4bDf566aE50537A507863612638680420645C";

async function main() {
  const api = new GmxApiSdk({ chainId: 42161 });
  const positions = await api.fetchPositionsInfo({ address: vaultAddress });
  console.log(`Found ${positions.length} positions`);
  for (const p of positions) {
    console.log("Full position keys:", Object.keys(p));
    console.log("market type:", typeof (p as any).market, "value:", (p as any).market);
    console.log("indexToken type:", typeof (p as any).indexToken, "value:", (p as any).indexToken);
    console.log("collateralToken type:", typeof (p as any).collateralToken, "value:", (p as any).collateralToken);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
