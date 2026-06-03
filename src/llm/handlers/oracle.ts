/**
 * Oracle Tool Handlers
 */

/**
 * Tool Handlers — all tool call handlers + registry.
 */

import type { Env, RequestContext } from "../../types.js";
import type { ToolResult } from "../client.js";
import { estimateGas } from "../client.js";
import { getTokenDecimals, getClient } from "../../services/vault.js";
import { resolveTokenAddress, resolveChainId, getNativeTokenSymbol } from "../../config.js";
import { parseUnits, formatUnits, type Address, type Hex } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../../abi/rigoblockVault.js";
import { buildOraclePoolSwapTx } from "../../services/oraclePool.js";
import { AuthError } from "../../services/auth.js";

/** Round a computed decimal string to 4 significant figures for display. */
function roundAmount(raw: string): string {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n === 0) return raw;
  const s = n.toPrecision(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
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

  const direction = (args.direction as string)?.toLowerCase() === "sell" ? "sell" : "buy";

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
    const requestedChain = args.chain ? resolveChainId(args.chain as string) : ctx.chainId;
    viaVault = !!hasVault && requestedChain === ctx.chainId;
  }
  const requestsVaultPath = viaVault || normalizedAmountOut !== "";

  // Auto-switch chain if provided (only safe for non-vault-dependent calls)
  let oracleChainSwitched: number | undefined;
  if (args.chain) {
    const requestedChain = resolveChainId(args.chain as string);
    if (requestedChain !== ctx.chainId) {
      if (requestsVaultPath) {
        throw new Error(
          `Cannot switch chains while using vault-dependent options (viaVault or amountOut). ` +
          `Connect a vault on chain ${requestedChain} first, or omit viaVault/amountOut.`
        );
      }
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
      const decimalsOut = await getTokenDecimals(ctx.chainId, tokenAddr, env.ALCHEMY_API_KEY);
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
          console.log(
            `[oracle] Estimated ${amountOut} ${tokenArg} → ${amountIn} ${nativeSymbol} ` +
            `(via vault oracle, +5% buffer)`
          );
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
          amountIn = roundAmount(formatUnits(buffered, decimalsOut));
          console.log(
            `[oracle] Estimated ${amountOut} ${nativeSymbol} → ${amountIn} ${tokenArg} ` +
            `(via vault oracle, +5% buffer)`
          );
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

  // Default amount: 0.001 units is small enough to be financially insignificant for
  // every token (0.001 ETH ≈ $2–6, 0.001 WBTC ≈ $100, 0.001 USDC ≈ $0.001), while
  // being non-zero — which is the only requirement for creating a BackgeoOracle
  // price observation (the tick is recorded at swap time regardless of size).
  if (!amountIn) {
    amountIn = "0.001";
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

  // Vault path: estimate gas — throws if the transaction would revert on-chain.
  // Never fall back to a hardcoded limit: a gas estimation failure means the
  // transaction will fail on-chain, and the user must not be allowed to sign it.
  if (viaVault && env.ALCHEMY_API_KEY && ctx.operatorAddress) {
    const vaultGas = await estimateGas(
      ctx.chainId, vaultAddr as Address,
      result.transaction.data as Hex, "0x0",
      ctx.operatorAddress, env.ALCHEMY_API_KEY, "oracle refresh",
    );
    result.transaction.gas = vaultGas;
  }

  // EOA path: simulate the transaction to catch reverts early and provide accurate gas
  if (!viaVault && env.ALCHEMY_API_KEY && ctx.operatorAddress) {
    try {
      const publicClient = getClient(ctx.chainId, env.ALCHEMY_API_KEY);
      const tx = result.transaction;

      // eth_call simulation — catches pool reverts, insufficient cardinality, etc.
      await publicClient.call({
        account: ctx.operatorAddress as Address,
        to: tx.to as Address,
        data: tx.data,
        value: BigInt(tx.value),
      });

      // eth_estimateGas for accurate gas limit
      const estimatedGas = await publicClient.estimateGas({
        account: ctx.operatorAddress as Address,
        to: tx.to as Address,
        data: tx.data,
        value: BigInt(tx.value),
      });

      // Add 20% buffer for execution variance
      const gasWithBuffer = (estimatedGas * 120n) / 100n;
      result.transaction.gas = "0x" + gasWithBuffer.toString(16);
      console.log(
        `[oracle] EOA simulation passed. Gas estimate: ${estimatedGas} → buffered: ${gasWithBuffer}`
      );
    } catch (simErr) {
      const reason = simErr instanceof Error ? simErr.message : String(simErr);
      console.warn(`[oracle] EOA simulation failed: ${reason}`);
      const balanceHint = direction === "buy"
        ? `the operator has insufficient ${nativeSymbol} balance`
        : `the operator has insufficient token balance or has not approved the Universal Router`;
      throw new Error(
        `Oracle refresh simulation failed: ${reason}. ` +
        `This usually means the pool is not initialized, ${balanceHint}, ` +
        `or the oracle hook rejected the swap. Verify the pool state and try again.`
      );
    }
  }

  return {
    message: result.message,
    transaction: viaVault ? result.transaction : { ...result.transaction, operatorOnly: true },
    chainSwitch: oracleChainSwitched,
  };

}

