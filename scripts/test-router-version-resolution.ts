/**
 * Probe: read the live AUniswapRouter adapter mapping from the Rigoblock
 * Authority for the swap selector (0x3593564c) on each supported chain and
 * print which x-universal-router-version the service would pin.
 *
 * Usage: npx tsx scripts/test-router-version-resolution.ts
 */
import { createPublicClient, http } from "viem";
import { readFileSync } from "fs";
import { base, arbitrum, mainnet, bsc, optimism, polygon } from "viem/chains";
import { AUTHORITY_ADDRESS, AUTHORITY_ABI } from "../src/abi/authority.js";
import { UR2_ADAPTERS } from "../src/services/routerVersion.js";

function loadAlchemyKey(): string {
  try {
    const raw = readFileSync(".dev.vars", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*ALCHEMY_API_KEY\s*=\s*"?([^"\s]+)"?\s*$/);
      if (m) return m[1];
    }
  } catch { /* fall through */ }
  const env = process.env.ALCHEMY_API_KEY;
  if (env) return env;
  throw new Error("ALCHEMY_API_KEY not found in .dev.vars or environment");
}

const CHAINS: Record<number, { chain: any; slug: string }> = {
  1: { chain: mainnet, slug: "eth-mainnet" },
  42161: { chain: arbitrum, slug: "arb-mainnet" },
  8453: { chain: base, slug: "base-mainnet" },
  56: { chain: bsc, slug: "bnb-mainnet" },
  10: { chain: optimism, slug: "opt-mainnet" },
  137: { chain: polygon, slug: "polygon-mainnet" },
};

async function main() {
  const apiKey = loadAlchemyKey();
  if (!apiKey) throw new Error("ALCHEMY_API_KEY not found in .dev.vars or environment");

  const selector = "0x3593564c" as `0x${string}`;
  for (const [chainIdStr, { chain, slug }] of Object.entries(CHAINS)) {
    const chainId = Number(chainIdStr);
    const ur2Adapter = UR2_ADAPTERS[chainId];
    const client = createPublicClient({
      chain,
      transport: http(`https://${slug}.g.alchemy.com/v2/${apiKey}`, {
        timeout: 10_000,
        fetchOptions: { headers: { Origin: "https://trader.rigoblock.com" } },
      }),
    });
    try {
      const adapter = (await client.readContract({
        address: AUTHORITY_ADDRESS,
        abi: AUTHORITY_ABI,
        functionName: "getApplicationAdapter",
        args: [selector],
      })) as string;
      const a = adapter.toLowerCase();
      const version =
        a === ur2Adapter.toLowerCase() ? "2.0 (UR2 adapter — current)" :
        a === "0x0000000000000000000000000000000000000000" ? "2.0 (unmapped)" :
        "2.1.2 (not the UR2 adapter)";
      console.log(`chain ${chainId}: adapter ${adapter} → ${version}`);
    } catch (err) {
      console.log(`chain ${chainId}: read failed (${err instanceof Error ? err.message.split("\n")[0] : err}) → defaults to 2.0`);
    }
  }
}

main();
