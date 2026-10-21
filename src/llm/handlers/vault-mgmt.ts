/**
 * Vault Mgmt Tool Handlers
 */

/**
 * Tool Handlers — all tool call handlers + registry.
 */

import type { Env, RequestContext, TransactionDraft } from "../../types.js";
import type { ToolResult } from "../client.js";
import {
  getPoolData, getNavData, getTokenDecimals, getVaultTokenBalance, encodeMint,
} from "../../services/vault.js";
import { getRpcProvider } from "../../services/rpcClient.js";
import { resolveTokenAddress } from "../../config.js";
import { encodeFunctionData, parseUnits, formatUnits, type Address, type Hex } from "viem";
import { POOL_FACTORY_ADDRESS, POOL_FACTORY_ABI } from "../../abi/poolFactory.js";
import { RIGOBLOCK_VAULT_ABI } from "../../abi/rigoblockVault.js";
import { ERC20_ABI } from "../../abi/erc20.js";
import { resolveChainArg, resolveChainName } from "../client.js";

/**
 * Mirrors PoolRegistry._assertValidNameAndSymbol + LibSanitize on-chain checks.
 * Name: 4-31 chars, [0-9A-Za-z ] only, no leading/trailing space — stored
 * case-sensitively. Symbol: 3-5 chars, same charset, must be ALL UPPERCASE.
 */
function assertValidPoolNameAndSymbol(name: string, symbol: string): void {
  const NAME_CHARSET = /^[0-9A-Za-z ]+$/;
  const SYMBOL_CHARSET = /^[0-9A-Z ]+$/;

  if (name.length < 4 || name.length > 31) {
    throw new Error(`Pool name must be 4-31 characters long (got ${name.length}: "${name}").`);
  }
  if (!NAME_CHARSET.test(name) || name.startsWith(" ") || name.endsWith(" ")) {
    throw new Error(
      `Pool name "${name}" contains invalid characters. Only letters, numbers and spaces are allowed, with no leading or trailing space.`,
    );
  }
  if (symbol.length < 3 || symbol.length > 5) {
    throw new Error(`Pool symbol must be 3-5 characters long (got ${symbol.length}: "${symbol}").`);
  }
  if (!SYMBOL_CHARSET.test(symbol) || symbol.startsWith(" ") || symbol.endsWith(" ")) {
    throw new Error(
      `Pool symbol "${symbol}" contains invalid characters. Only uppercase letters, numbers and spaces are allowed.`,
    );
  }
}

export async function handle_deploy_smart_pool(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }

  // Handle optional chain switch
  let chainSwitched: number | undefined;
  if (args.chain) {
    const match = resolveChainArg((args.chain as string).trim());
    if (match.id !== ctx.chainId) {
      ctx.chainId = match.id;
      chainSwitched = match.id;
    }
  }

  const chainName = resolveChainName(ctx.chainId);
  // The registry (PoolRegistry._assertValidNameAndSymbol) is strict: the name
  // is stored case-SENSITIVELY exactly as passed (4-31 chars), while the symbol
  // must be UPPERCASE (3-5 chars); both allow only [0-9A-Za-z ] with no
  // leading/trailing space (LibSanitize.assertIsValidCheck). Validate here so
  // a rejected createPool never reaches the user's wallet, preserve the name's
  // case exactly as the user typed it, and uppercase the symbol.
  const poolName = String(args.name ?? "").trim();
  const poolSymbol = String(args.symbol ?? "").trim().toUpperCase();
  assertValidPoolNameAndSymbol(poolName, poolSymbol);

  // Resolve base token — default to ETH (address(0))
  let baseTokenAddress: Address = "0x0000000000000000000000000000000000000000";
  let baseTokenArg = (args.baseToken as string) || "ETH";

  // HyperEVM (Hyperliquid) and Lighter Devnet pools are USDC-only: the
  // AHyperliquid / ALighter adapters settle margin in USDC, so a pool with any
  // other base token could never trade there. Default to USDC and reject any
  // other base token with actionable guidance.
  const USDC_ONLY: Record<number, string> = {
    999: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
    19529: "0xf2A5728d366c6d0f764Af612cD47F3608E2B4d5B",
  };
  const chainUsdc = USDC_ONLY[ctx.chainId];
  if (chainUsdc) {
    const requested = (args.baseToken as string) || "USDC";
    const isUsdc =
      requested.toUpperCase() === "USDC" ||
      (requested.startsWith("0x") && requested.toLowerCase() === chainUsdc.toLowerCase());
    if (!isUsdc) {
      throw new Error(
        `${chainName} smart pools must use USDC as the base token — the perp adapter settles ` +
        `margin in USDC, so a pool with a different base token could never trade there. ` +
        `Requested: "${requested}". Deploy with USDC, or switch to another chain for an ETH-based pool.`,
      );
    }
    baseTokenAddress = chainUsdc as Address;
    baseTokenArg = "USDC";
  } else if (baseTokenArg.startsWith("0x") && baseTokenArg.length === 42) {
    baseTokenAddress = baseTokenArg as Address;
  } else if (baseTokenArg.toUpperCase() !== "ETH") {
    baseTokenAddress = await resolveTokenAddress(ctx.chainId, baseTokenArg) as Address;
  }

  // Preflight: a non-native base token must be a contract on this chain.
  // Otherwise initialization fails at `assert(baseToken.code.length > 0)` and
  // the factory only surfaces the opaque POOL_INITIALIZATION_FAILED_ERROR —
  // catch it here with an actionable message instead.
  if (baseTokenAddress !== "0x0000000000000000000000000000000000000000") {
    try {
      const code = await getRpcProvider(ctx.chainId).getCode({ address: baseTokenAddress });
      if (code === "0x") {
        throw new Error(
          `Base token ${baseTokenAddress} has no contract code on ${chainName} — deploying with it would ` +
          `fail with POOL_INITIALIZATION_FAILED. A token address from the wrong chain (mainnet USDC used on ` +
          `another chain is the usual cause). Verify the token address for ${chainName}.`,
        );
      }
    } catch (codeErr) {
      // Only block on a confirmed empty result; an unreadable RPC must not
      // prevent a deploy that MetaMask would price and confirm itself (same
      // policy as the createPool simulation below).
      if (codeErr instanceof Error && /has no contract code on/.test(codeErr.message)) throw codeErr;
    }
  }

  const data = encodeFunctionData({
    abi: POOL_FACTORY_ABI,
    functionName: "createPool",
    args: [poolName, poolSymbol, baseTokenAddress],
  });

  // Simulate the deployment before it reaches the wallet, so a reverting
  // createPool is rejected here with its reason instead of a failed on-chain tx.
  try {
    await getRpcProvider(ctx.chainId).call({
      account: (ctx.operatorAddress ?? undefined) as Address | undefined,
      to: POOL_FACTORY_ADDRESS as Address,
      data,
      blockTag: "latest",
    });
  } catch (simErr) {
    const simMsg = simErr instanceof Error ? simErr.message : String(simErr);
    // Only block on an actual execution revert; an unreadable RPC must not
    // prevent a deploy that MetaMask would price and confirm itself.
    // ("failed" is deliberately excluded — transport errors like "fetch
    // failed" must not be mistaken for a revert.)
    if (/revert|denied|invalid/i.test(simMsg)) {
      throw new Error(
        `Deployment simulation failed on ${chainName}: ${simMsg}. ` +
        `The transaction would revert — fix the parameters before signing.`,
      );
    }
  }

  const transaction: TransactionDraft = {
    to: POOL_FACTORY_ADDRESS as Address,
    data,
    value: "0x0",
    chainId: ctx.chainId,
    description: `Deploy new Rigoblock pool: ${poolName} (${poolSymbol})`,
    operatorOnly: true,
  };

  const baseLabel = baseTokenArg.toUpperCase() === "ETH"
    ? "ETH (native)"
    : baseTokenArg.startsWith("0x")
      ? `${baseTokenArg.slice(0, 6)}…${baseTokenArg.slice(-4)}`
      : baseTokenArg.toUpperCase();

  const message = [
    "✅ Pool deployment ready",
    `Name: ${poolName}`,
    `Symbol: ${poolSymbol}`,
    `Base token: ${baseLabel}`,
    `Chain: ${chainName}`,
    `Factory: ${POOL_FACTORY_ADDRESS}`,
    "",
    "Sign this transaction to deploy your new smart pool.",
    "After deployment, the new pool address will appear in the transaction receipt.",
    "You can then paste it in the vault address field to start trading.",
  ].join("\n");

  return { message, transaction, chainSwitch: chainSwitched };

}

export async function handle_fund_pool(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }

  const amountStr = args.amount as string;
  if (!amountStr) {
    throw new Error("Amount is required. Specify how much base token to deposit (e.g., '1.5' ETH).");
  }

  const recipient = (args.recipient as string) || ctx.operatorAddress;
  const chainName = resolveChainName(ctx.chainId);

  // 1. Read pool data (base token) and NAV in parallel
  const [poolData, navData] = await Promise.all([
    getPoolData(ctx.chainId, ctx.vaultAddress as Address),
    getNavData(ctx.chainId, ctx.vaultAddress as Address),
  ]);

  const baseToken = poolData.baseToken;
  const isNativeBase = baseToken.toLowerCase() === "0x0000000000000000000000000000000000000000";

  // 2. Resolve base token decimals and symbol
  let baseDecimals: number;
  let baseSymbol: string;
  if (isNativeBase) {
    baseDecimals = 18;
    // Determine native symbol based on chain
    const nativeSymbols: Record<number, string> = { 56: "BNB", 137: "POL" };
    baseSymbol = nativeSymbols[ctx.chainId] || "ETH";
  } else {
    baseDecimals = await getTokenDecimals(ctx.chainId, baseToken);
    const tokenInfo = await getVaultTokenBalance(ctx.chainId, ctx.vaultAddress as Address, baseToken as Address);
    baseSymbol = tokenInfo.symbol;
  }

  // 3. Parse amount to smallest units
  const amountInWei = parseUnits(amountStr, baseDecimals);

  // 4. Calculate amountOutMin from NAV with 5% slippage
  //    unitaryValue = price of 1 pool token in base token units (18 decimals)
  //    expectedPoolTokens = amountIn * 10^18 / unitaryValue
  //    amountOutMin = expectedPoolTokens * 0.95
  const unitaryValue = navData.unitaryValue;
  // An UNPRICED pool must be detected by its zero total value, not just a zero
  // unitary value: updateUnitaryValue() — the live contract NAV computation —
  // returns the pool's initial unitary value (10^decimals) even when the pool
  // is empty. Pricing against that initial value would demand ~10^12x more
  // pool tokens than a first mint actually produces and the mint reverts
  // on-chain.
  const isUnpricedPool = unitaryValue === 0n || navData.totalValue === 0n;
  let amountOutMin: bigint;
  if (isUnpricedPool) {
    // First mint (empty pool) — no NAV yet, accept any amount
    amountOutMin = 0n;
  } else {
    const expectedPoolTokens = (amountInWei * (10n ** 18n)) / unitaryValue;
    amountOutMin = (expectedPoolTokens * 95n) / 100n; // 5% slippage
  }

  // Format for display
  const unitaryValueFormatted = isUnpricedPool
    ? "N/A (first mint)"
    : formatUnits(unitaryValue, 18);
  const expectedTokensFormatted = isUnpricedPool
    ? amountStr
    : formatUnits((amountInWei * (10n ** 18n)) / unitaryValue, 18);
  const minTokensFormatted = formatUnits(amountOutMin, 18);

  // 5. Build the mint transaction
  const mintData = encodeMint(
    recipient as Address,
    amountInWei,
    amountOutMin,
  );

  if (isNativeBase) {
    // Native base token — send as msg.value, no approval needed
    const transaction: TransactionDraft = {
      to: ctx.vaultAddress as Address,
      data: mintData,
      value: "0x" + amountInWei.toString(16),
      chainId: ctx.chainId,
        description: `Fund pool: deposit ${amountStr} ${baseSymbol} into ${poolData.name}`,
      operatorOnly: true,
    };

    const message = [
      `✅ Pool funding ready`,
      `Pool: ${poolData.name} (${poolData.symbol})`,
      `Deposit: ${amountStr} ${baseSymbol}`,
      `Price per token: ${unitaryValueFormatted} ${baseSymbol}`,
      `Expected pool tokens: ~${parseFloat(expectedTokensFormatted).toFixed(6)} ${poolData.symbol}`,
      `Min pool tokens (5% slippage): ${parseFloat(minTokensFormatted).toFixed(6)} ${poolData.symbol}`,
      `Chain: ${chainName}`,
      `Recipient: ${recipient}`,
      "",
      "Sign this transaction to deposit capital and receive pool tokens.",
    ].join("\n");

    return { message, transaction };
  }

  // ERC-20 base token — mint needs an approve only when the operator's
  // current allowance to the pool is insufficient. Read it on-chain so a
  // repeat request after a mined approval returns the mint directly instead
  // of the same approve again.
  const allowance: bigint = await getRpcProvider(ctx.chainId).readContract({
    address: baseToken as Address,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [ctx.operatorAddress as Address, ctx.vaultAddress as Address],
    // Explicit block tag: a bare eth_call intermittently executes against
    // unattached state on Lighter Devnet and false-positives "execution
    // reverted" (same failure class as the pinned eth_estimateGas).
    blockTag: "latest",
  });

  if (allowance >= amountInWei) {
    const transaction: TransactionDraft = {
      to: ctx.vaultAddress as Address,
      data: mintData,
      value: "0x0",
      chainId: ctx.chainId,
      description: `Fund pool: deposit ${amountStr} ${baseSymbol} into ${poolData.name}`,
      operatorOnly: true,
    };
    const message = [
      `✅ Pool funding ready — approval already on-chain`,
      `Pool: ${poolData.name} (${poolData.symbol})`,
      `Deposit: ${amountStr} ${baseSymbol}`,
      `NAV per token: ${unitaryValueFormatted} ${baseSymbol}`,
      `Expected pool tokens: ~${parseFloat(expectedTokensFormatted).toFixed(6)} ${poolData.symbol}`,
      `Min pool tokens (5% slippage): ${parseFloat(minTokensFormatted).toFixed(6)} ${poolData.symbol}`,
      `Chain: ${chainName}`,
      `Recipient: ${recipient}`,
      "",
      "Your existing token approval covers this deposit — sign the mint transaction only.",
    ].join("\n");
    return { message, transaction };
  }

  // Insufficient allowance — return the approve transaction first; once it is
  // mined, the deterministic follow-up re-runs this tool (nextStep) and the
  // allowance re-read returns the mint directly.
  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [ctx.vaultAddress as Address, amountInWei],
  });

  const transaction: TransactionDraft = {
    to: baseToken as Address,
    data: approveData,
    value: "0x0",
    chainId: ctx.chainId,
    description: `Approve ${amountStr} ${baseSymbol} for pool ${poolData.name}`,
    operatorOnly: true,
    nextStep: {
      toolName: "fund_pool",
      arguments: {
        amount: amountStr,
        ...(args.recipient ? { recipient: args.recipient } : {}),
      },
    },
  };

  const message = [
    `✅ Pool funding ready (2 transactions)`,
    `Pool: ${poolData.name} (${poolData.symbol})`,
    `Deposit: ${amountStr} ${baseSymbol}`,
    `NAV per token: ${unitaryValueFormatted} ${baseSymbol}`,
    `Expected pool tokens: ~${parseFloat(expectedTokensFormatted).toFixed(6)} ${poolData.symbol}`,
    `Min pool tokens (5% slippage): ${parseFloat(minTokensFormatted).toFixed(6)} ${poolData.symbol}`,
    `Chain: ${chainName}`,
    `Recipient: ${recipient}`,
    "",
    `**Step 1/2:** Sign the approval transaction to allow the pool to transfer your ${baseSymbol}.`,
    "**Step 2/2:** The approval is detected on-chain automatically — the app prepares the mint transaction " +
    "as soon as the approval confirms, without another request.",
  ].join("\n");

  return { message, transaction };

}


// ── Pool implementation upgrade ───────────────────────────────────────

/** EIP-1967 implementation slot (keccak("eip1967.proxy.implementation") − 1),
 * matching the slot EUpgrade.upgradeImplementation writes. */
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** upgradeImplementation() — EUpgrade extension, delegatecalled through the pool. */
const UPGRADE_IMPLEMENTATION_SELECTOR = "0x466f3dc3";

function slotAddress(raw: `0x${string}` | undefined): Address | null {
  if (!raw || raw === "0x" || raw.length < 42) return null;
  const addr = `0x${raw.slice(-40)}`;
  return BigInt(addr) === 0n ? null : (addr as Address);
}

/**
 * Preview what upgradeImplementation() would do: the pool's current EIP-1967
 * implementation and the implementation the factory beacon currently serves
 * (the factory is deterministically deployed at the same address on every
 * chain). Best-effort — nulls when a read fails; the on-chain call itself is
 * the ground truth.
 */
async function previewUpgrade(
  chainId: number,
  vault: Address,
): Promise<{ current: Address | null; target: Address | null }> {
  const client = getRpcProvider(chainId);
  const current = await client
    .getStorageAt({ address: vault, slot: EIP1967_IMPLEMENTATION_SLOT })
    .then(slotAddress)
    .catch(() => null);
  const target = await client
    .call({ to: POOL_FACTORY_ADDRESS, data: "0x5c60da1b", blockTag: "latest" }) // implementation()
    .then((r) => slotAddress(r.data as `0x${string}`))
    .catch(() => null);
  return { current, target };
}

export async function handle_upgrade_pool(
  _env: Env,
  ctx: RequestContext,
  _args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }
  if (!ctx.vaultAddress) {
    throw new Error("Set a vault address first.");
  }
  const vault = ctx.vaultAddress as Address;
  const preview = await previewUpgrade(ctx.chainId, vault);

  if (preview.current && preview.target) {
    if (preview.current.toLowerCase() === preview.target.toLowerCase()) {
      throw new Error(
        `Pool ${vault} is already on the current implementation (${preview.current}). Nothing to upgrade.`,
      );
    }
  } else if (!preview.current) {
    throw new Error(
      `Pool ${vault} has no EIP-1967 implementation set — this does not look like a Rigoblock pool proxy.`,
    );
  }

  const transaction: TransactionDraft = {
    to: vault,
    data: UPGRADE_IMPLEMENTATION_SELECTOR,
    value: "0x0",
    chainId: ctx.chainId,
    description: "Upgrade pool to the current Rigoblock implementation",
    operatorOnly: true,
  };

  const message = [
    `✅ Pool upgrade ready`,
    `Pool: ${vault}`,
    `Current implementation: ${preview.current ?? "unreadable"}`,
    `New implementation: ${preview.target ?? "unreadable"}`,
    "",
    "Sign this transaction to pull the current implementation from the factory beacon into your pool. " +
    "The pool's storage, NAV, and positions are preserved — only the code changes.",
  ].join("\n");

  return { message, transaction };
}


export async function handle_update_nav(
  _env: Env,
  ctx: RequestContext,
  _args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }
  if (!ctx.vaultAddress) {
    throw new Error("Set a vault address first.");
  }
  const vault = ctx.vaultAddress as Address;
  const chainName = resolveChainName(ctx.chainId);

  // Simulate the update first: this is the exact computation the transaction
  // will perform, so the values shown here are what the on-chain log will
  // record (modulo balance movements before the tx mines). A revert here
  // (e.g. NavLocked during a Lighter/HyperCore settlement window) surfaces
  // before the tx reaches the wallet. netTotalValue is on the pool-token
  // decimals scale (same convention as the chat's get_vault_info display).
  const [nav, poolData] = await Promise.all([
    getNavData(ctx.chainId, vault),
    getPoolData(ctx.chainId, vault),
  ]);
  const poolDecimals = poolData.decimals ?? 18;
  const unitaryValueFormatted = nav.unitaryValue === 0n
    ? "N/A (pool not priced yet)"
    : formatUnits(nav.unitaryValue, 18);

  const transaction: TransactionDraft = {
    to: vault,
    data: encodeFunctionData({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "updateUnitaryValue",
    }),
    value: "0x0",
    chainId: ctx.chainId,
    description: "Update pool NAV (unitary value)",
    operatorOnly: true,
  };

  const message = [
    `✅ NAV update ready`,
    `Pool: ${poolData.name} (${poolData.symbol})`,
    `Chain: ${chainName}`,
    `Unitary value (to be written): ${unitaryValueFormatted}`,
    `Net total value: ${formatUnits(nav.totalValue, poolDecimals)}`,
    "",
    "Sign this transaction to recompute and store the pool's unitary value on-chain. " +
    "The new NAV is recorded in the transaction logs — use it to reconcile against the value shown in chat.",
  ].join("\n");

  return { message, transaction };
}
