/**
 * Rigoblock Vault interaction service.
 *
 * Reads vault state and builds calldata for trading via the IAUniswapRouter
 * interface (execute, modifyLiquidities). The vault routes these calls to
 * the appropriate Uniswap contracts automatically.
 *
 * In Phase 1, the operator signs and broadcasts the transaction from their
 * own wallet in the browser — no agent wallet or delegation involved.
 */

import {
  createPublicClient,
  http,
  formatUnits,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { ERC20_ABI } from "../abi/erc20.js";
import { getChain, getRpcUrl } from "../config.js";
import type { VaultInfo } from "../types.js";

/**
 * Allowed Origin header for Alchemy domain-restricted keys.
 * Cloudflare Workers don't send Origin by default, so Alchemy rejects
 * requests as "Unspecified". Setting this header fixes domain validation.
 */
const ALCHEMY_ORIGIN = "https://trader.rigoblock.com";

/** Cache clients per chainId+key to avoid recreating */
const clientCache = new Map<string, PublicClient>();

/** Cache token decimals: `${chainId}:${address}` → decimals */
const decimalsCache = new Map<string, number>();

function getClient(chainId: number, alchemyKey?: string): PublicClient {
  const cacheKey = `${chainId}:${alchemyKey ? "alchemy" : "public"}`;
  const existing = clientCache.get(cacheKey);
  if (existing) return existing;
  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId, alchemyKey);
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, rpcUrl?.includes("alchemy.com")
      ? { fetchOptions: { headers: { Origin: ALCHEMY_ORIGIN } } }
      : undefined,
    ),
  });
  clientCache.set(cacheKey, client);
  return client;
}

/**
 * Get the decimals for any ERC-20 token on-chain, with caching.
 *
 * Native tokens (0x0000...0000 or 0xEEEE...EEEE) always return 18.
 * Results are cached per chain+address since decimals never change.
 */
export async function getTokenDecimals(
  chainId: number,
  tokenAddress: string,
  alchemyKey?: string,
): Promise<number> {
  const lower = tokenAddress.toLowerCase();

  // Native tokens always have 18 decimals
  if (
    lower === "0x0000000000000000000000000000000000000000" ||
    lower === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  ) {
    return 18;
  }

  const cacheKey = `${chainId}:${lower}`;
  const cached = decimalsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const client = getClient(chainId, alchemyKey);
  try {
    const decimals = (await client.readContract({
      address: tokenAddress as Address,
      abi: ERC20_ABI,
      functionName: "decimals",
    })) as number;

    const result = Number(decimals);
    decimalsCache.set(cacheKey, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("is not valid JSON") || msg.includes("Unexpected token")) {
      throw new Error(
        `RPC error on chain ${chainId}: could not read token at ${tokenAddress.slice(0, 10)}…. ` +
        `The token may not exist on this chain, or the RPC endpoint is unavailable.`,
      );
    }
    // Contract call reverted → token likely doesn't exist at this address
    if (msg.includes("reverted") || msg.includes("execution reverted")) {
      throw new Error(
        `Token contract ${tokenAddress.slice(0, 10)}… does not exist or is not a valid ERC-20 on chain ${chainId}.`,
      );
    }
    throw new Error(
      `Failed to read token decimals for ${tokenAddress.slice(0, 10)}… on chain ${chainId}.`,
    );
  }
}

/**
 * Fetch basic vault information.
 */
export async function getVaultInfo(
  chainId: number,
  vaultAddress: Address,
  alchemyKey?: string,
): Promise<VaultInfo> {
  const client = getClient(chainId, alchemyKey);

  try {
    const [name, symbol, owner, totalSupply] = await Promise.all([
      client.readContract({
        address: vaultAddress,
        abi: RIGOBLOCK_VAULT_ABI,
        functionName: "name",
      }),
      client.readContract({
        address: vaultAddress,
        abi: RIGOBLOCK_VAULT_ABI,
        functionName: "symbol",
      }),
      client.readContract({
        address: vaultAddress,
        abi: RIGOBLOCK_VAULT_ABI,
        functionName: "owner",
      }),
      client.readContract({
        address: vaultAddress,
        abi: RIGOBLOCK_VAULT_ABI,
        functionName: "totalSupply",
      }),
    ]);

    return {
      address: vaultAddress,
      name: name as string,
      symbol: symbol as string,
      owner: owner as Address,
      totalSupply: formatUnits(totalSupply as bigint, 18),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("is not valid JSON") || msg.includes("Unexpected token")) {
      throw new Error(
        `RPC error on chain ${chainId}: could not read vault at ${vaultAddress.slice(0, 10)}…. ` +
        `The RPC endpoint may be unavailable.`,
      );
    }
    throw err;
  }
}

/**
 * Check ERC-20 token balance held by the vault.
 */
export async function getVaultTokenBalance(
  chainId: number,
  vaultAddress: Address,
  tokenAddress: Address,
  alchemyKey?: string,
): Promise<{ balance: bigint; decimals: number; symbol: string }> {
  const client = getClient(chainId, alchemyKey);

  // For native ETH
  if (
    tokenAddress.toLowerCase() ===
    "0x0000000000000000000000000000000000000000" ||
    tokenAddress.toLowerCase() ===
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  ) {
    const balance = await client.getBalance({ address: vaultAddress });
    return { balance, decimals: 18, symbol: "ETH" };
  }

  const [balance, decimals, symbol] = await Promise.all([
    client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [vaultAddress],
    }),
    client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "decimals",
    }),
    client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "symbol",
    }),
  ]);

  return {
    balance: balance as bigint,
    decimals: Number(decimals),
    symbol: symbol as string,
  };
}

/**
 * Encode a call to vault.execute(commands, inputs, deadline).
 *
 * This is the Uniswap Universal Router `execute` function that the
 * Rigoblock vault exposes through its adapter system.
 */
export function encodeVaultExecute(
  commands: Hex,
  inputs: Hex[],
  deadline: bigint,
): Hex {
  return encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "execute",
    args: [commands, inputs, deadline],
  });
}

/**
 * Encode a call to vault.execute(commands, inputs) — no deadline.
 */
export function encodeVaultExecuteNoDeadline(
  commands: Hex,
  inputs: Hex[],
): Hex {
  return encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "execute",
    args: [commands, inputs],
  });
}

/**
 * Encode a call to vault.modifyLiquidities(unlockData, deadline).
 */
export function encodeVaultModifyLiquidities(
  unlockData: Hex,
  deadline: bigint,
): Hex {
  return encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "modifyLiquidities",
    args: [unlockData, deadline],
  });
}

/**
 * Verify that a given address is the vault owner (operator).
 */
export async function isVaultOwner(
  chainId: number,
  vaultAddress: Address,
  address: Address,
  alchemyKey?: string,
): Promise<boolean> {
  const client = getClient(chainId, alchemyKey);

  try {
    const owner = await client.readContract({
      address: vaultAddress,
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "owner",
    });
    return (owner as Address).toLowerCase() === address.toLowerCase();
  } catch (err) {
    // Provide clearer error if the RPC endpoint returned non-JSON (e.g. invalid API key)
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("is not valid JSON") || msg.includes("Unexpected token")) {
      throw new Error(
        `RPC error on chain ${chainId}: the node returned an invalid response. ` +
        `This usually means the API key is invalid or rate-limited.`,
      );
    }
    throw err;
  }
}

// ── Pool data & capital provision ──────────────────────────────────────

/** Pool data returned by vault.getData() */
export interface PoolData {
  name: string;
  symbol: string;
  decimals: number;
  owner: Address;
  baseToken: Address;
}

/**
 * Read the pool's core data including base token address.
 */
export async function getPoolData(
  chainId: number,
  vaultAddress: Address,
  alchemyKey?: string,
): Promise<PoolData> {
  const client = getClient(chainId, alchemyKey);
  const result = await client.readContract({
    address: vaultAddress,
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "getData",
  });
  const [name, symbol, decimals, owner, baseToken] = result as [string, string, bigint, Address, Address];
  return {
    name,
    symbol,
    decimals: Number(decimals),
    owner,
    baseToken,
  };
}

/** NAV data returned by vault.getNavDataView() */
export interface NavData {
  totalValue: bigint;
  unitaryValue: bigint;
  timestamp: bigint;
}

/**
 * Read the pool's current NAV data (total value, unitary value, timestamp).
 */
export async function getNavData(
  chainId: number,
  vaultAddress: Address,
  alchemyKey?: string,
): Promise<NavData> {
  const client = getClient(chainId, alchemyKey);
  const result = await client.readContract({
    address: vaultAddress,
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "getNavDataView",
  });
  const navData = result as { totalValue: bigint; unitaryValue: bigint; timestamp: bigint };
  return {
    totalValue: navData.totalValue,
    unitaryValue: navData.unitaryValue,
    timestamp: navData.timestamp,
  };
}

/**
 * Encode a mint(recipient, amountIn, amountOutMin) call on the vault.
 */
export function encodeMint(
  recipient: Address,
  amountIn: bigint,
  amountOutMin: bigint,
): Hex {
  return encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "mint",
    args: [recipient, amountIn, amountOutMin],
  });
}
