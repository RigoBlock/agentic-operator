import { GmxSdk } from "@gmx-io/sdk";
import type { Address } from "viem";
import { getRpcUrl } from "../config.js";
import { getClient } from "./vault.js";

const GMX_ORACLE_URL = "https://arbitrum-api.gmxinfra.io";
const GMX_SUBSQUID_URL = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";

export function createGmxSdk(account?: Address, alchemyKey?: string): GmxSdk {
  // Use the project's viem client so Alchemy gets the Origin header it requires.
  // The SDK's own viem transport does not send that header, which makes
  // domain-restricted Alchemy keys return a non-JSON response and causes all
  // GMX reads to silently fail / return empty data.
  const publicClient = getClient(42161, alchemyKey);

  return new GmxSdk({
    chainId: 42161,
    rpcUrl: getRpcUrl(42161, alchemyKey) ?? "https://arb1.arbitrum.io/rpc",
    oracleUrl: GMX_ORACLE_URL,
    subsquidUrl: GMX_SUBSQUID_URL,
    account,
    // The SDK bundles its own newer viem version, so the structural PublicClient
    // types don't line up with the project's viem. Runtime behaviour is identical,
    // so we cast to satisfy the compiler.
    publicClient: publicClient as any,
  });
}
