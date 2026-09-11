/**
 * Live verification of the Authority-derived delegable selector set.
 * Mirrors getDelegableSelectors() in src/services/delegation.ts using public RPCs.
 * Run after governance changes adapter mappings to see the per-chain effect.
 */
import { createPublicClient, http } from "viem";
import { ALLOWED_VAULT_SELECTORS } from "../src/abi/rigoblockVault.js";
import { AUTHORITY_ADDRESS, AUTHORITY_ABI } from "../src/abi/authority.js";

const ZERO = "0x0000000000000000000000000000000000000000";

const RPCS: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  56: "https://bsc-rpc.publicnode.com",
  130: "https://unichain-rpc.publicnode.com",
  999: "https://rpc.hyperliquid.xyz/evm",
};

const all = Object.values(ALLOWED_VAULT_SELECTORS);

for (const [chainIdStr, rpc] of Object.entries(RPCS)) {
  const chainId = Number(chainIdStr);
  const client = createPublicClient({ transport: http(rpc) });
  const results = await client.multicall({
    multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11",
    contracts: all.map((selector) => ({
      address: AUTHORITY_ADDRESS,
      abi: AUTHORITY_ABI,
      functionName: "getApplicationAdapter" as const,
      args: [selector],
    })),
  });
  const delegable = all.filter((_, i) => {
    const r = results[i];
    if (r.status !== "success") throw new Error(`call failed for ${all[i]}: ${r.error}`);
    return (r.result as string).toLowerCase() !== ZERO;
  });
  console.log(`chain ${chainId}: ${delegable.length}/${all.length} delegable`);
  console.log("  " + delegable.join(" "));
}
