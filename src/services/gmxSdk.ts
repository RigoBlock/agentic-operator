import { GmxSdk } from "@gmx-io/sdk";
import type { Address } from "viem";
import { getRpcUrl } from "../config.js";
import { getRpcProvider } from "./rpcClient.js";
import type { Env } from "../types.js";

const GMX_ORACLE_URL = "https://arbitrum-api.gmxinfra.io";
const GMX_SUBSQUID_URL = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";

export function createGmxSdk(account?: Address): GmxSdk {
  const publicClient = getRpcProvider(42161);

  return new GmxSdk({
    chainId: 42161,
    rpcUrl: getRpcUrl(42161),
    oracleUrl: GMX_ORACLE_URL,
    subsquidUrl: GMX_SUBSQUID_URL,
    account,
    // The SDK bundles its own newer viem version, so the structural PublicClient
    // types don't line up with the project's viem. Runtime behaviour is identical,
    // so we cast to satisfy the compiler.
    publicClient: publicClient as any,
  });
}
