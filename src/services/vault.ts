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
  formatUnits,
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { ERC20_ABI } from "../abi/erc20.js";
import type { VaultInfo } from "../types.js";
import { getClient } from "./rpcClient.js";

/** Cache token decimals: `${chainId}:${address}` → decimals */
const decimalsCache = new Map<string, number>();

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
 * Uses V4's getPool() which returns name, symbol, decimals, owner, baseToken
 * in a single call. Falls back to individual getters if unavailable.
 */
export async function getVaultInfo(
  chainId: number,
  vaultAddress: Address,
  alchemyKey?: string,
): Promise<VaultInfo> {
  const client = getClient(chainId, alchemyKey);

  try {
    // Try V4's getPool() + totalSupply in one Multicall3 round-trip.
    const [poolResult, totalSupplyResult] = await client.multicall({
      contracts: [
        { address: vaultAddress, abi: RIGOBLOCK_VAULT_ABI, functionName: "getPool" },
        { address: vaultAddress, abi: RIGOBLOCK_VAULT_ABI, functionName: "totalSupply" },
      ],
    });
    if (poolResult.status !== "success" || totalSupplyResult.status !== "success") {
      throw new Error("getPool/totalSupply multicall failed");
    }
    const pool = poolResult.result as { name: string; symbol: string; decimals: number; owner: Address; baseToken: Address };
    const dec = Number(pool.decimals);
    return {
      address: vaultAddress,
      name: pool.name,
      symbol: pool.symbol,
      owner: pool.owner,
      totalSupply: formatUnits(totalSupplyResult.result as bigint, dec),
      decimals: dec,
    };
  } catch {
    // Fallback: batch individual view calls into one multicall.
    try {
      const decimalsAbi = [{ name: "decimals", type: "function" as const, stateMutability: "view" as const, inputs: [], outputs: [{ type: "uint8" as const }] }] as const;
      const [nameResult, symbolResult, ownerResult, totalSupplyResult, decimalsResult] = await client.multicall({
        contracts: [
          { address: vaultAddress, abi: RIGOBLOCK_VAULT_ABI, functionName: "name" },
          { address: vaultAddress, abi: RIGOBLOCK_VAULT_ABI, functionName: "symbol" },
          { address: vaultAddress, abi: RIGOBLOCK_VAULT_ABI, functionName: "owner" },
          { address: vaultAddress, abi: RIGOBLOCK_VAULT_ABI, functionName: "totalSupply" },
          { address: vaultAddress, abi: decimalsAbi, functionName: "decimals" },
        ],
      });
      const dec = decimalsResult.status === "success" ? Number(decimalsResult.result) : 18;
      return {
        address: vaultAddress,
        name: (nameResult.result ?? "") as string,
        symbol: (symbolResult.result ?? "") as string,
        owner: (ownerResult.result ?? "0x0000000000000000000000000000000000000000") as Address,
        totalSupply: formatUnits((totalSupplyResult.result ?? 0n) as bigint, dec),
        decimals: dec,
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

  // Batch balance/decimals/symbol into a single Multicall3 round-trip.
  // Transport-level batching already catches parallel readContract calls, but
  // explicit multicall is deterministic regardless of microtask timing.
  const results = await client.multicall({
    contracts: [
      {
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [vaultAddress],
      },
      {
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "decimals",
      },
      {
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "symbol",
      },
    ],
  });

  const balance = results[0].result as bigint;
  const decimals = Number(results[1].result);
  const symbol = results[2].result as string;

  return { balance, decimals, symbol };
}

/**
 * Batch-read vault balances for a list of ERC-20 token addresses.
 * Treats failures as 0 balance (matching the per-call `.catch` behavior).
 */
export async function getVaultTokenBalancesBulk(
  chainId: number,
  vaultAddress: Address,
  tokenAddresses: Address[],
  alchemyKey?: string,
): Promise<Map<string, bigint>> {
  if (tokenAddresses.length === 0) return new Map();
  const client = getClient(chainId, alchemyKey);
  const results = await client.multicall({
    contracts: tokenAddresses.map((address) => ({
      address,
      abi: ERC20_ABI,
      functionName: "balanceOf" as const,
      args: [vaultAddress] as const,
    })),
    allowFailure: true,
  });

  const balances = new Map<string, bigint>();
  for (let i = 0; i < tokenAddresses.length; i++) {
    const result = results[i];
    balances.set(
      tokenAddresses[i].toLowerCase(),
      result.status === "success" && result.result != null ? (result.result as bigint) : 0n,
    );
  }
  return balances;
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

/** Pool data returned by vault.getPool() */
export interface PoolData {
  name: string;
  symbol: string;
  decimals: number;
  owner: Address;
  baseToken: Address;
}

/**
 * Read the pool's core data including base token address.
 * Uses V4's getPool() (returns struct with baseToken), falls back
 * to individual view calls if getPool() is unavailable.
 */
export async function getPoolData(
  chainId: number,
  vaultAddress: Address,
  alchemyKey?: string,
): Promise<PoolData> {
  const client = getClient(chainId, alchemyKey);

  try {
    const [poolResult] = await client.multicall({
      contracts: [
        { address: vaultAddress, abi: RIGOBLOCK_VAULT_ABI, functionName: "getPool" },
      ],
    });
    if (poolResult.status !== "success") {
      throw new Error("getPool multicall failed");
    }
    const pool = poolResult.result as { name: string; symbol: string; decimals: number; owner: Address; baseToken: Address };
    return {
      name: pool.name,
      symbol: pool.symbol,
      decimals: Number(pool.decimals),
      owner: pool.owner,
      baseToken: pool.baseToken,
    };
  } catch {
    // Fallback to batched individual view calls
    const simpleAbi = [
      { name: "name", type: "function" as const, stateMutability: "view" as const, inputs: [], outputs: [{ type: "string" as const }] },
      { name: "symbol", type: "function" as const, stateMutability: "view" as const, inputs: [], outputs: [{ type: "string" as const }] },
      { name: "decimals", type: "function" as const, stateMutability: "view" as const, inputs: [], outputs: [{ type: "uint8" as const }] },
      { name: "owner", type: "function" as const, stateMutability: "view" as const, inputs: [], outputs: [{ type: "address" as const }] },
    ] as const;
    const [nameResult, symbolResult, decimalsResult, ownerResult] = await client.multicall({
      contracts: [
        { address: vaultAddress, abi: simpleAbi, functionName: "name" },
        { address: vaultAddress, abi: simpleAbi, functionName: "symbol" },
        { address: vaultAddress, abi: simpleAbi, functionName: "decimals" },
        { address: vaultAddress, abi: simpleAbi, functionName: "owner" },
      ],
    });
    return {
      name: (nameResult.result ?? "") as string,
      symbol: (symbolResult.result ?? "") as string,
      decimals: Number(decimalsResult.result ?? 18),
      owner: (ownerResult.result ?? "0x0000000000000000000000000000000000000000") as Address,
      baseToken: "0x0000000000000000000000000000000000000000" as Address,
    };
  }
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

/** Effective pool state from updateUnitaryValue() simulation */
export interface EffectivePoolState {
  /** NAV per pool token (live computation — accounts for virtual supply) */
  unitaryValue: bigint;
  /** Total pool value in base token units (at pool.decimals scale) */
  netTotalValue: bigint;
  /** Effective supply = totalSupply + virtualSupply (from crosschain transfers) */
  effectiveSupply: bigint;
  /** Pool decimals (= base token decimals on this chain) */
  decimals: number;
  /** Pool base token address */
  baseToken: Address;
}

/**
 * Read effective pool state via updateUnitaryValue() simulation.
 *
 * updateUnitaryValue() recomputes the live NAV accounting for all token
 * positions, liabilities, and virtual supply from crosschain transfers. We call
 * it via eth_call (no state change) and derive effective supply as
 * netTotalValue / unitaryValue, which captures both minted supply and virtual
 * supply. The function is permissionless — any address can call it.
 */
export async function getEffectivePoolState(
  chainId: number,
  vaultAddress: Address,
  alchemyKey?: string,
): Promise<EffectivePoolState> {
  const client = getClient(chainId, alchemyKey);

  // Batch updateUnitaryValue() simulation + getPool() into one Multicall3 round-trip.
  const [navResult, poolResult] = await client.multicall({
    contracts: [
      { address: vaultAddress, abi: RIGOBLOCK_VAULT_ABI, functionName: "updateUnitaryValue" },
      { address: vaultAddress, abi: RIGOBLOCK_VAULT_ABI, functionName: "getPool" },
    ],
  });

  if (navResult.status !== "success") {
    throw new Error(`updateUnitaryValue simulation failed on chain ${chainId}`);
  }
  if (poolResult.status !== "success") {
    throw new Error(`getPool failed on chain ${chainId}`);
  }

  const nav = navResult.result as { unitaryValue: bigint; netTotalValue: bigint; netTotalLiabilities: bigint };
  const pool = poolResult.result as { name: string; symbol: string; decimals: number; owner: Address; baseToken: Address };

  const { unitaryValue, netTotalValue } = nav;

  // effectiveSupply = netTotalValue × 10^decimals / unitaryValue
  // This is the supply that includes both minted tokens AND virtual supply
  // from crosschain transfers — the true denominator for NAV computation.
  const decPow = 10n ** BigInt(pool.decimals);
  const effectiveSupply = unitaryValue > 0n
    ? (netTotalValue * decPow) / unitaryValue
    : 0n;

  return {
    unitaryValue,
    netTotalValue,
    effectiveSupply,
    decimals: pool.decimals,
    baseToken: pool.baseToken,
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
