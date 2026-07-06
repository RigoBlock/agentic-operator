/**
 * Settings Tool Handlers
 */

import type { Env, RequestContext } from "../../types.js";
import type { ToolResult } from "../client.js";
import {
  setStoredSlippage,
  setSwapShieldTolerance,
  clearSwapShieldTolerance,
  MIN_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
} from "../../services/swapShield.js";
import {
  setNavShieldThreshold,
  clearNavShieldThreshold,
  DEFAULT_MAX_NAV_DROP_PCT,
  MIN_NAV_DROP_PCT,
  MAX_NAV_DROP_PCT,
} from "../../services/navGuard.js";

/**
 * Settings tools may only be invoked by authenticated vault operators.
 *
 * `operatorVerified` is true only when the caller has proven vault ownership:
 * - Browser UI: verified EIP-191 signature (header or body auth).
 * - Telegram: paired vault with on-chain owner check.
 *
 * x402-paid external agents never receive `operatorVerified = true`; they pay
 * for API access only. This prevents a rogue agent from raising slippage or
 * swap-shield tolerance to drain a vault.
 */
function ensureOperatorOnly(ctx: RequestContext, toolName: string): void {
  if (!ctx.operatorVerified) {
    throw new Error(
      `The '${toolName}' tool can only be used by the vault operator. ` +
      `External agents cannot modify operator safety settings.`,
    );
  }
}

export async function handle_set_default_slippage(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  ensureOperatorOnly(ctx, toolName);

  const raw = String(args.slippage ?? "").trim();
  let bps: number;
  const percentMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*%$/i);
  const bpsMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*bps$/i);
  const plainMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)$/);
  if (percentMatch) {
    const num = parseFloat(percentMatch[1]);
    if (isNaN(num) || num <= 0) {
      throw new Error("Invalid slippage value. Provide a positive number (e.g., '0.5%', '50bps', or '0.5').");
    }
    bps = Math.round(num * 100);
  } else if (bpsMatch) {
    const num = parseFloat(bpsMatch[1]);
    if (isNaN(num) || num <= 0) {
      throw new Error("Invalid slippage value. Provide a positive number (e.g., '0.5%', '50bps', or '0.5').");
    }
    if (!Number.isInteger(num)) {
      throw new Error(`Non-integer bps value '${raw}' is ambiguous — did you mean ${Math.round(num)}bps or ${num}%? Use the '%' suffix for percentages.`);
    }
    bps = num;
  } else if (plainMatch) {
    const num = parseFloat(plainMatch[1]);
    if (isNaN(num) || num <= 0) {
      throw new Error("Invalid slippage value. Provide a positive number (e.g., '0.5%', '50bps', or '0.5').");
    }
    if (Number.isInteger(num) && num >= MIN_SLIPPAGE_BPS && num <= MAX_SLIPPAGE_BPS) {
      bps = Math.round(num);
    } else {
      bps = Math.round(num * 100);
    }
  } else {
    throw new Error("Invalid slippage value. Use a positive number, optionally suffixed with '%' or 'bps' (e.g., '0.5%', '50bps', or '0.5').");
  }
  if (bps < MIN_SLIPPAGE_BPS || bps > MAX_SLIPPAGE_BPS) {
    throw new Error(
      `Slippage must be between ${MIN_SLIPPAGE_BPS / 100}% and ${MAX_SLIPPAGE_BPS / 100}%. ` +
      `Got: ${bps / 100}% (${bps} bps).`,
    );
  }
  await setStoredSlippage(env.KV, ctx.operatorAddress!, bps);
  return {
    message: `✅ Default slippage set to ${bps / 100}% (${bps} bps). This applies to all future swaps until changed.`,
  };

}

export async function handle_set_swap_shield_tolerance(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  ensureOperatorOnly(ctx, toolName);

  const raw = String(args.tolerance ?? "").trim();
  let pct: number;
  const percentMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*%$/i);
  const plainMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)$/);
  if (percentMatch) {
    const num = parseFloat(percentMatch[1]);
    if (isNaN(num) || num <= 0) {
      throw new Error("Invalid tolerance value. Provide a positive number (e.g., '30%' or '30').");
    }
    pct = num;
  } else if (plainMatch) {
    const num = parseFloat(plainMatch[1]);
    if (isNaN(num) || num <= 0) {
      throw new Error("Invalid tolerance value. Provide a positive number (e.g., '30%' or '30').");
    }
    pct = num;
  } else {
    throw new Error("Invalid tolerance format. Use a number like '30%' or '30'.");
  }
  await setSwapShieldTolerance(
    env.KV,
    ctx.operatorAddress!,
    pct,
  );
  return {
    message:
      `✅ Swap Shield tolerance temporarily set to ${pct}% for 10 minutes. ` +
      `Swaps will be allowed if the DEX quote diverges up to ${pct}% from the oracle price. ` +
      `The shield will reset to the default 5% automatically.\n\n` +
      `The NAV shield still protects against catastrophic trades.`,
  };

}

export async function handle_enable_swap_shield(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  ensureOperatorOnly(ctx, toolName);

  await clearSwapShieldTolerance(
    env.KV,
    ctx.operatorAddress!,
  );
  return {
    message: "✅ Swap Shield tolerance reset to default (5%). All swaps will be checked against oracle prices.",
  };

}

export async function handle_set_nav_shield_threshold(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  ensureOperatorOnly(ctx, toolName);

  const raw = String(args.threshold ?? "").trim();
  let pct: bigint;
  const percentMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*%$/i);
  const plainMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)$/);
  if (percentMatch) {
    const num = parseFloat(percentMatch[1]);
    if (isNaN(num) || num <= 0) {
      throw new Error("Invalid threshold value. Provide a positive number (e.g., '15%' or '15').");
    }
    pct = BigInt(Math.round(num));
  } else if (plainMatch) {
    const num = parseFloat(plainMatch[1]);
    if (isNaN(num) || num <= 0) {
      throw new Error("Invalid threshold value. Provide a positive number (e.g., '15%' or '15').");
    }
    pct = BigInt(Math.round(num));
  } else {
    throw new Error("Invalid threshold format. Use a number like '15%' or '15'.");
  }

  await setNavShieldThreshold(env.KV, ctx.operatorAddress!, pct);
  return {
    message: (
      `🛡️ NAV Shield temporarily set to ${Number(pct)}% for 10 minutes. ` +
      `Any trade that would drop your pool's unit price by more than ${Number(pct)}% will be blocked.\n\n` +
      `This override applies to all your vaults on every chain and auto-resets to the default ${Number(DEFAULT_MAX_NAV_DROP_PCT)}%. ` +
      `Say "reset NAV shield to default" to restore it immediately.`
    ),
  };
}

export async function handle_enable_nav_shield(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  ensureOperatorOnly(ctx, toolName);

  await clearNavShieldThreshold(env.KV, ctx.operatorAddress!);
  return {
    message: `✅ NAV Shield reset to default (${Number(DEFAULT_MAX_NAV_DROP_PCT)}%). Trades that would reduce the vault's unit price by more than ${Number(DEFAULT_MAX_NAV_DROP_PCT)}% will be blocked. Any temporary override has been cleared.`,
  };
}
