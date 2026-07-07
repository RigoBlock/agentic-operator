/**
 * Oracle Tool Handlers
 */

/**
 * Tool Handlers — all tool call handlers + registry.
 */

import type { Env, RequestContext } from "../../types.js";
import type { ToolResult } from "../client.js";

import { getTokenDecimals } from "../../services/vault.js";
import { getClient } from "../../services/rpcClient.js";
import { resolveTokenAddress, resolveChainId, resolveChainName, getNativeTokenSymbol, NATIVE_TOKEN } from "../../config.js";
import { parseUnits, formatUnits, encodeFunctionData, type Address, type Hex, type Abi } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../../abi/rigoblockVault.js";
import { buildOraclePoolSwapTx, UNIVERSAL_ROUTER } from "../../services/oraclePool.js";
import { AuthError } from "../../services/auth.js";

/** Round a computed decimal string to 4 significant figures for display. */
function roundAmount(raw: string): string {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n === 0) return raw;
  const s = n.toPrecision(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Standard ERC-20 approve ABI fragment for building approval transactions. */
const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { type: "address", name: "spender" },
      { type: "uint256", name: "amount" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

/** Permit2 contract address — standard approval mechanism for Uniswap V4. */
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

/** Permit2 allowance checker ABI. */
const PERMIT2_ABI = [
  {
    name: "allowance",
    type: "function",
    inputs: [
      { type: "address", name: "owner" },
      { type: "address", name: "token" },
      { type: "address", name: "spender" },
    ],
    outputs: [
      { type: "uint160", name: "amount" },
      { type: "uint48", name: "expiration" },
      { type: "uint48", name: "nonce" },
    ],
    stateMutability: "view",
  },
  {
    name: "approve",
    type: "function",
    inputs: [
      { type: "address", name: "token" },
      { type: "address", name: "spender" },
      { type: "uint160", name: "amount" },
      { type: "uint48", name: "expiration" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/** Try to extract a human-readable reason from a V4 / Universal Router revert. */
function extractRevertReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // SafeTransferFrom failure — almost always missing approval
  if (lower.includes("stf") || lower.includes("safetransferfrom")) {
    return "The token transfer failed (SafeTransferFrom). Most likely the token has not been approved for Permit2.";
  }

  // Insufficient balance
  if (lower.includes("insufficient balance") || lower.includes("erc20: transfer amount exceeds balance")) {
    return "Insufficient token balance for this swap.";
  }

  // Pool not initialized / no liquidity
  if (lower.includes("pool not initialized") || lower.includes("no liquidity")) {
    return "The oracle pool is not initialized or has no liquidity.";
  }

  // Oracle hook specific
  if (lower.includes("cardinality") || lower.includes("observation")) {
    return "The oracle pool needs more observations (cardinality too low). Try again after the pool has more activity.";
  }

  // Generic execution reverted — try to find a custom error selector
  const selectorMatch = msg.match(/0x([a-fA-F0-9]{8})/);
  if (selectorMatch) {
    return `Transaction reverted with error 0x${selectorMatch[1]}.`;
  }

  return msg.slice(0, 300);
}

/** Returns true if `token` is a native-token symbol, wrapped-native shorthand, or the zero/sentinel address. */
function isNativeTokenSymbolOrAddress(chainId: number, token: string): boolean {
  const normalized = token.trim().toUpperCase();
  const nativeSymbol = getNativeTokenSymbol(chainId).toUpperCase();
  if (normalized === nativeSymbol) return true;
  if (normalized === `W${nativeSymbol}`) return true;
  // Polygon-specific legacy symbols.
  if (nativeSymbol === "POL" && (normalized === "MATIC" || normalized === "WMATIC")) return true;
  if (normalized === "0X0000000000000000000000000000000000000000") return true;
  if (normalized === "0XEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE") return true;
  return false;
}

/**
 * Try to infer the chain from a native-token symbol appearing in tokenIn/tokenOut.
 * Only returns a chain when the symbol maps to a single chain (e.g. POL→137, BNB→56)
 * so we don't guess among ETH chains.
 */
function inferChainFromNativeTokens(tokenIn: string, tokenOut: string): number | undefined {
  const normalizeNativeSymbol = (s: string): string => {
    const n = s.trim().toUpperCase();
    if (n === "MATIC" || n === "WMATIC") return "POL";
    if (n.startsWith("W")) return n.slice(1);
    return n;
  };

  const nativeToChains: Record<string, number[]> = {};
  for (const [chainIdStr, symbol] of Object.entries(NATIVE_TOKEN)) {
    const sym = symbol.toUpperCase();
    if (!nativeToChains[sym]) nativeToChains[sym] = [];
    nativeToChains[sym].push(Number(chainIdStr));
  }

  for (const raw of [tokenIn, tokenOut]) {
    const sym = normalizeNativeSymbol(raw);
    const chains = nativeToChains[sym];
    if (chains && chains.length === 1) return chains[0];
  }
  return undefined;
}

/**
 * Derive the swap direction from tokenIn/tokenOut.
 * The oracle pool is always native/ERC20. tokenIn/tokenOut must be one native and one ERC-20.
 * Returns 'buy' if native is paid (native → token), 'sell' if ERC-20 is paid (token → native).
 */
export function deriveDirection(
  chainId: number,
  tokenArg: string,
  tokenIn: string,
  tokenOut: string,
): "buy" | "sell" {
  const inIsNative = isNativeTokenSymbolOrAddress(chainId, tokenIn);
  const outIsNative = isNativeTokenSymbolOrAddress(chainId, tokenOut);
  const inIsToken = tokenIn.trim().toUpperCase() === tokenArg.trim().toUpperCase();
  const outIsToken = tokenOut.trim().toUpperCase() === tokenArg.trim().toUpperCase();

  if (inIsNative && outIsToken) return "buy";
  if (inIsToken && outIsNative) return "sell";

  throw new Error(
    `tokenIn/tokenOut must be one native token (${getNativeTokenSymbol(chainId)}) and one ERC-20 ('${tokenArg}'). ` +
    `Got tokenIn='${tokenIn}', tokenOut='${tokenOut}'.`
  );
}

export async function handle_refresh_oracle_feed(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new AuthError("Wallet not connected. Connect your wallet first.", 401);
  }

  const tokenArg = args.token as string;
  if (!tokenArg) {
    throw new Error("'token' is required. Specify the token symbol whose oracle feed is stale (e.g., 'GRG', 'USDC').");
  }

  // Guard: the oracle pool is always native-token (currency0) vs ERC-20 (currency1).
  // Reject attempts to pass the native token as the `token` argument so the LLM/user
  // must explicitly name the ERC-20 whose feed needs refreshing.
  if (isNativeTokenSymbolOrAddress(ctx.chainId, tokenArg)) {
    throw new Error(
      `${tokenArg.toUpperCase()} is the native token on ${resolveChainName(ctx.chainId)} and cannot be used as the oracle-pool token. ` +
      `The BackgeoOracle pool always pairs the native token (currency0) with an ERC-20. ` +
      `Please specify the ERC-20 token whose price feed is stale (e.g., 'GRG', 'USDC').`
    );
  }

  // Tracks whether we had to auto-switch chains so the caller can persist it.
  let oracleChainSwitched: number | undefined;

  const tokenInArg = args.tokenIn as string | undefined;
  const tokenOutArg = args.tokenOut as string | undefined;
  if (!tokenInArg || !tokenOutArg) {
    throw new Error("tokenIn and tokenOut are required. Specify what the trader pays and receives (e.g., tokenIn='GRG', tokenOut='POL').");
  }

  // If the LLM omitted the chain arg or the chain-suffix parser missed it, try to
  // recover from the native-token symbol in tokenIn/tokenOut. Only do this for
  // symbols that map to a single chain (POL, BNB) to avoid guessing among ETH chains.
  const currentNative = getNativeTokenSymbol(ctx.chainId).toUpperCase();
  const inLooksNative = isNativeTokenSymbolOrAddress(ctx.chainId, tokenInArg);
  const outLooksNative = isNativeTokenSymbolOrAddress(ctx.chainId, tokenOutArg);
  if (!inLooksNative && !outLooksNative) {
    const inferred = inferChainFromNativeTokens(tokenInArg, tokenOutArg);
    if (inferred && inferred !== ctx.chainId) {
      ctx.chainId = inferred;
      oracleChainSwitched = inferred;
    }
  }

  const direction = deriveDirection(ctx.chainId, tokenArg, tokenInArg, tokenOutArg);

  // Vault-dependent options (viaVault, amountOut) require ctx.vaultAddress to be on
  // the active chain. Check this BEFORE mutating ctx.chainId to avoid leaving context
  // in a partially-switched state if the guard throws.
  // Use the same normalization as the amountOut coercion below so that numeric 0,
  // whitespace strings, and null/undefined are all handled consistently.
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  // Use toFixed(18) for numeric inputs to avoid scientific notation (e.g.
  // 0.0000001 → "1e-7" via String()) that parseUnits rejects.
  const toDecimalString = (v: unknown): string => {
    if (v == null) return "";
    if (typeof v === "number") return v.toFixed(18);
    return String(v).trim();
  };
  const normalizedAmountOut = toDecimalString(args.amountOut);
  // Default viaVault to true when a vault is connected on the SAME chain,
  // unless explicitly set to false. This allows oracle refreshes on other
  // chains without blocking the auto chain-switch.
  const hasVault = ctx.vaultAddress && ctx.vaultAddress !== ZERO_ADDR;
  const viaVaultExplicit = args.viaVault === true || args.viaVault === "true" || args.viaVault === false || args.viaVault === "false";
  let viaVault: boolean;
  if (viaVaultExplicit) {
    viaVault = args.viaVault === true || args.viaVault === "true";
  } else {
    // Default to vault path whenever a vault is connected.
    // The EOA path is only used when explicitly requested or no vault is connected.
    viaVault = !!hasVault;
  }

  // Auto-switch chain if explicitly provided.
  if (args.chain) {
    const requestedChain = resolveChainId(args.chain as string);
    if (requestedChain !== ctx.chainId) {
      ctx.chainId = requestedChain;
      oracleChainSwitched = requestedChain;
    }
  }

  const nativeSymbol = getNativeTokenSymbol(ctx.chainId);

  // Coerce to decimal string; toDecimalString() uses toFixed(18) for numbers
  // to avoid scientific notation (e.g. 0.0000001 → "1e-7") that parseUnits rejects.
  // Accept both legacy 'amountEth' and new 'amount' parameter names.
  let amountIn = toDecimalString(args.amount ?? args.amountEth);
  const amountOut = normalizedAmountOut; // already coerced above for the vault-path guard

  // Reject ambiguous input: only one of amount or amountOut may be provided.
  if (amountIn && amountOut) {
    throw new Error(
      direction === "buy"
        ? "Provide amount (native token input) OR amountOut (token output to receive), not both."
        : "Provide amount (token input) OR amountOut (native token output to receive), not both."
    );
  }

  // If amountOut is provided instead of amount, estimate the required input
  // using the vault's on-chain BackgeoOracle (convertTokenAmount).
  if (!amountIn && amountOut) {
    if (!ctx.vaultAddress || ctx.vaultAddress === ZERO_ADDR || !env.ALCHEMY_API_KEY) {
      throw new Error(
        `amountOut requires a connected vault with an active RPC key for oracle estimation. ` +
        `Connect a vault first, or provide amount directly.`
      );
    }
    try {
      const tokenAddr = await resolveTokenAddress(ctx.chainId, tokenArg);
      const tokenDecimals = await getTokenDecimals(ctx.chainId, tokenAddr, env.ALCHEMY_API_KEY);
      // For buy direction the desired output is the ERC-20 token; for sell direction
      // the desired output is the native token (always 18 decimals).
      const decimalsOut = direction === "buy" ? tokenDecimals : 18;
      const desiredOutRaw = parseUnits(amountOut, decimalsOut);
      if (desiredOutRaw <= 0n) {
        throw new Error(
          `amountOut must be a positive value; got "${amountOut}". Provide a value greater than zero.`
        );
      }
      const publicClient = getClient(ctx.chainId, env.ALCHEMY_API_KEY);
      const NATIVE_ZERO = "0x0000000000000000000000000000000000000000" as Address;
      const normalizeForOracle = (addr: string) =>
        addr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
          ? NATIVE_ZERO
          : (addr as Address);
      if (direction === "buy") {
        const estimatedIn = await publicClient.readContract({
          address: ctx.vaultAddress as Address,
          abi: RIGOBLOCK_VAULT_ABI,
          functionName: "convertTokenAmount",
          args: [normalizeForOracle(tokenAddr), desiredOutRaw, NATIVE_ZERO],
        }) as bigint;
        if (estimatedIn > 0n) {
          const buffered = (estimatedIn * 105n) / 100n;
          amountIn = roundAmount(formatUnits(buffered, 18));
        } else if (estimatedIn < 0n) {
          throw new Error(`Oracle returned a negative estimate for ${amountOut} ${tokenArg} — unexpected oracle condition.`);
        } else {
          throw new Error(`Oracle returned a zero estimate for ${amountOut} ${tokenArg}.`);
        }
      } else {
        // sell direction: estimate token input for desired native output
        const estimatedIn = await publicClient.readContract({
          address: ctx.vaultAddress as Address,
          abi: RIGOBLOCK_VAULT_ABI,
          functionName: "convertTokenAmount",
          args: [NATIVE_ZERO, desiredOutRaw, normalizeForOracle(tokenAddr)],
        }) as bigint;
        if (estimatedIn > 0n) {
          const buffered = (estimatedIn * 105n) / 100n;
          // estimatedIn is in token decimals (the input token), not native decimals.
          amountIn = roundAmount(formatUnits(buffered, tokenDecimals));
        } else if (estimatedIn < 0n) {
          throw new Error(`Oracle returned a negative estimate for ${amountOut} ${nativeSymbol} — unexpected oracle condition.`);
        } else {
          throw new Error(`Oracle returned a zero estimate for ${amountOut} ${nativeSymbol}.`);
        }
      }
    } catch (err) {
      console.warn(
        `[oracle] convertTokenAmount estimate failed for ${tokenArg} output=${amountOut}:`,
        err instanceof Error ? err.message : err
      );
      throw new Error(
        `Could not estimate input for amountOut="${amountOut}" ${tokenArg}: oracle estimation failed. ` +
        `Provide amount directly instead.`
      );
    }
  }

  // One of amount or amountOut must be provided. There is no safe default: a swap
  // with an unspecified size is undefined behaviour and should not be submitted.
  if (!amountIn) {
    throw new Error(
      `Provide either amount (exact input in ${tokenInArg} units) or amountOut (desired output in ${tokenOutArg} units). ` +
      `The oracle pool swap size cannot be defaulted.`
    );
  }

  // Treat zero address as "no vault" (frontend uses it as a placeholder before connecting).
  const vaultAddr = viaVault && hasVault
    ? (ctx.vaultAddress as Address)
    : undefined;

  if (viaVault && !vaultAddr) {
    throw new Error(
      `viaVault=true requires a connected vault. Connect a vault first or omit viaVault to use the EOA path.`
    );
  }

  const result = await buildOraclePoolSwapTx(
    tokenArg,
    amountIn,
    ctx.chainId,
    env.ALCHEMY_API_KEY,
    vaultAddr,
    direction,
  );

  // Destructure values we need for pre-flight checks
  const tokenAddr = result.poolInfo.currency1;
  const tokenSymbol = result.poolInfo.tokenSymbol;
  const amountInWei = result.amountInWei;

  // Vault transaction gas is finalized centrally by prepareTransaction.
  if (viaVault) {
    result.transaction.gas = "0x0";
  }

  // EOA path: pre-flight balance / allowance check to catch missing approvals early.
  if (!viaVault && env.ALCHEMY_API_KEY && ctx.operatorAddress) {
    const publicClient = getClient(ctx.chainId, env.ALCHEMY_API_KEY);
    const operator = ctx.operatorAddress as Address;

    // Pre-flight: for sell direction, ensure the operator has the token AND has
    // approved the Universal Router (via Permit2). Permit2 is a two-step system:
    //   1. ERC-20 approve(Permit2, amount) — token contract
    //   2. Permit2.approve(token, UniversalRouter, amount, expiration) — Permit2 contract
    // We check both and return the missing approval transaction so the user can sign it.
    if (direction === "sell") {
      try {
        const universalRouter = UNIVERSAL_ROUTER[ctx.chainId];
        const preflightContracts: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }[] = [
          {
            address: tokenAddr,
            abi: [{ name: "balanceOf", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const,
            functionName: "balanceOf",
            args: [operator],
          },
          {
            address: tokenAddr,
            abi: [{ name: "allowance", type: "function", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const,
            functionName: "allowance",
            args: [operator, PERMIT2],
          },
        ];
        if (universalRouter) {
          preflightContracts.push({
            address: PERMIT2,
            abi: PERMIT2_ABI,
            functionName: "allowance",
            args: [operator, tokenAddr, universalRouter],
          });
        }

        const [balanceResult, erc20AllowanceResult, permit2AllowanceResult] = await publicClient.multicall({ contracts: preflightContracts });

        const balance = balanceResult.status === "success" ? (balanceResult.result as bigint) : 0n;
        if (balance < amountInWei) {
          throw new Error(
            `Your wallet (${operator.slice(0, 6)}…${operator.slice(-4)}) has ${formatUnits(balance, result.tokenDecimals)} ${tokenSymbol}, ` +
            `but the oracle refresh requires ${amountIn} ${tokenSymbol}. ` +
            `Fund your wallet with more ${tokenSymbol} and try again.`
          );
        }

        // Step 1: ERC-20 allowance to Permit2
        const erc20Allowance = erc20AllowanceResult.status === "success" ? (erc20AllowanceResult.result as bigint) : 0n;
        if (erc20Allowance < amountInWei) {
          // Build an ERC-20 approve(Permit2, amountInWei) transaction for the user to sign first.
          const approveData = encodeFunctionData({
            abi: ERC20_APPROVE_ABI,
            functionName: "approve",
            args: [PERMIT2, amountInWei],
          });
          return {
            message: (
              `🔐 Step 1/2: ERC-20 Approval Required\n\n` +
              `Your wallet has not approved Permit2 to spend ${tokenSymbol}. ` +
              `Sign this approval transaction first, then retry the oracle refresh.\n\n` +
              `Token: ${tokenSymbol}\n` +
              `Amount: ${amountIn} ${tokenSymbol}\n` +
              `Spender: Permit2 (${PERMIT2})`
            ),
            transaction: {
              to: tokenAddr,
              data: approveData,
              value: "0x0",
              chainId: ctx.chainId,
              gas: "0x0",
              description: `Step 1/2: Approve ${amountIn} ${tokenSymbol} for Permit2`,
              operatorOnly: true,
            },
          };
        }

        // Step 2: Permit2 allowance for the Universal Router
        if (universalRouter && permit2AllowanceResult) {
          const [permit2Amount, permit2Expiration] = permit2AllowanceResult.status === "success"
            ? (permit2AllowanceResult.result as unknown as [bigint, number, number])
            : [0n, 0];

          const now = Math.floor(Date.now() / 1000);
          const permit2Sufficient = permit2Amount >= amountInWei && permit2Expiration > now;

          if (!permit2Sufficient) {
            // Build a Permit2.approve(token, UniversalRouter, amount, expiration) transaction.
            const expiration = now + 30 * 24 * 60 * 60; // 30 days
            const permit2ApproveData = encodeFunctionData({
              abi: PERMIT2_ABI,
              functionName: "approve",
              args: [tokenAddr, universalRouter, amountInWei, expiration],
            });
            return {
              message: (
                `🔐 Step 2/2: Permit2 Approval Required\n\n` +
                `Permit2 has not authorised the Universal Router to spend ${tokenSymbol} on your behalf. ` +
                `Sign this Permit2 approval transaction first, then retry the oracle refresh.\n\n` +
                `Token: ${tokenSymbol}\n` +
                `Amount: ${amountIn} ${tokenSymbol}\n` +
                `Spender: Universal Router (${universalRouter})\n` +
                `Expires: 30 days`
              ),
              transaction: {
                to: PERMIT2,
                data: permit2ApproveData,
                value: "0x0",
                chainId: ctx.chainId,
                gas: "0x0",
                description: `Step 2/2: Permit2 approve ${amountIn} ${tokenSymbol} for Universal Router`,
                operatorOnly: true,
              },
            };
          }
        }
      } catch (preflightErr) {
        // Re-throw pre-flight errors (balance/allowance) directly — they're already actionable.
        if (preflightErr instanceof Error && preflightErr.message.includes("Your wallet")) {
          throw preflightErr;
        }
        // For unexpected RPC errors, fall through to simulation.
        console.warn("[oracle] Pre-flight check failed:", preflightErr);
      }
    } else {
      // buy direction: ensure operator has enough native token for msg.value
      try {
        const balance = await publicClient.getBalance({ address: operator });
        if (balance < amountInWei) {
          throw new Error(
            `Your wallet (${operator.slice(0, 6)}…${operator.slice(-4)}) has ${formatUnits(balance, 18)} ${nativeSymbol}, ` +
            `but the oracle refresh requires ${amountIn} ${nativeSymbol}. ` +
            `Fund your wallet with more ${nativeSymbol} and try again.`
          );
        }
      } catch (preflightErr) {
        if (preflightErr instanceof Error && preflightErr.message.includes("Your wallet")) {
          throw preflightErr;
        }
        console.warn("[oracle] Pre-flight balance check failed:", preflightErr);
      }
    }

    // Gas is finalized centrally by prepareTransaction; keep operatorOnly so it
    // is signed from the user's wallet rather than executed via delegation.
    result.transaction.gas = "0x0";
  }

  return {
    message: result.message,
    transaction: viaVault ? result.transaction : { ...result.transaction, operatorOnly: true },
    chainSwitch: oracleChainSwitched,
  };

}
