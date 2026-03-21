/**
 * Simulate adding liquidity to XAUT/USDT Uniswap v4 pool on Arbitrum via the Rigoblock vault.
 *
 * This script reproduces the exact calldata that buildAddLiquidityTx() builds
 * and simulates it via eth_call to verify it doesn't revert.
 *
 * Usage: ALCHEMY_KEY=... VAULT_ADDRESS=0x... npx tsx scripts/simulate-lp.ts
 *
 * The vault must hold sufficient XAUT + USDT for the LP position.
 */

import {
  type Address,
  type Hex,
  encodeAbiParameters,
  keccak256,
  parseUnits,
  formatUnits,
  encodeFunctionData,
  decodeFunctionResult,
  createPublicClient,
  http,
} from "viem";
import { arbitrum } from "viem/chains";

// ── Config ──

const ALCHEMY_KEY = process.env.ALCHEMY_KEY;
const VAULT_ADDRESS = (process.env.VAULT_ADDRESS ?? "").toLowerCase() as Address;

if (!VAULT_ADDRESS || VAULT_ADDRESS.length !== 42) {
  console.error("Set VAULT_ADDRESS env var to a Rigoblock vault on Arbitrum");
  process.exit(1);
}

const CHAIN_ID = 42161;
const POOL_ID = "0xb896675bfb20eed4b90d83f64cf137a860a99a86604f7fac201a822f2b4abc34" as Hex;
const XAUT = "0x40461291347e1eCbb09499F3371D3f17f10d7159" as Address;
const USDT = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Address;
const XAUT_DECIMALS = 6;
const USDT_DECIMALS = 6;

// Pool key: fee=6000, tickSpacing=120, hooks=zero
const FEE = 6000;
const TICK_SPACING = 120;
const HOOKS = "0x0000000000000000000000000000000000000000" as Address;

// Ensure currency0 < currency1
const isXautLower = XAUT.toLowerCase() < USDT.toLowerCase();
const currency0 = isXautLower ? XAUT : USDT;
const currency1 = isXautLower ? USDT : XAUT;

console.log(`currency0: ${currency0} (${isXautLower ? "XAUT" : "USDT"})`);
console.log(`currency1: ${currency1} (${isXautLower ? "USDT" : "XAUT"})`);

// Verify pool ID
const computedPoolId = keccak256(
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [currency0, currency1, FEE, TICK_SPACING, HOOKS],
  ),
);
console.log(`\nComputed pool ID: ${computedPoolId}`);
console.log(`Expected pool ID: ${POOL_ID}`);
console.log(`Match: ${computedPoolId.toLowerCase() === POOL_ID.toLowerCase()}`);

// ── RPC client ──

const rpcUrl = ALCHEMY_KEY
  ? `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`
  : "https://arb1.arbitrum.io/rpc";

const client = createPublicClient({
  chain: arbitrum,
  transport: http(rpcUrl),
});

// ── Constants ──

const POOLS_SLOT = 6n;
const Q96 = 2n ** 96n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;

const Actions = {
  MINT_POSITION: 0x02,
  SETTLE_PAIR: 0x0d,
  TAKE_PAIR: 0x11,
} as const;

const POOL_KEY_ABI = {
  type: "tuple" as const,
  components: [
    { type: "address" as const, name: "currency0" },
    { type: "address" as const, name: "currency1" },
    { type: "uint24" as const, name: "fee" },
    { type: "int24" as const, name: "tickSpacing" },
    { type: "address" as const, name: "hooks" },
  ],
};

const VAULT_ABI = [
  {
    name: "modifyLiquidities",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "unlockData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "owner",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const EXTSLOAD_ABI = [{
  name: "extsload",
  type: "function" as const,
  stateMutability: "view" as const,
  inputs: [{ name: "slot", type: "bytes32" as const }],
  outputs: [{ name: "", type: "bytes32" as const }],
}] as const;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "account", type: "address" as const }],
    outputs: [{ name: "", type: "uint256" as const }],
  },
  {
    name: "decimals",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "", type: "uint8" as const }],
  },
] as const;

const POOL_MANAGER_ARB = "0x360e68faccca8ca495c1b759fd9eee466db9fb32" as Address;

// ── Math helpers ──

function getSqrtRatioAtTick(tick: number): bigint {
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}

function alignTick(tick: number, tickSpacing: number): number {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

function getLiquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (amount0 * sqrtA * sqrtB) / (Q96 * (sqrtB - sqrtA));
}

function getLiquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (amount1 * Q96) / (sqrtB - sqrtA);
}

function getLiquidityForAmounts(
  sqrtPriceX96: bigint, sqrtA: bigint, sqrtB: bigint,
  amount0: bigint, amount1: bigint,
): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtPriceX96 <= sqrtA) return getLiquidityForAmount0(sqrtA, sqrtB, amount0);
  if (sqrtPriceX96 < sqrtB) {
    const l0 = getLiquidityForAmount0(sqrtPriceX96, sqrtB, amount0);
    const l1 = getLiquidityForAmount1(sqrtA, sqrtPriceX96, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return getLiquidityForAmount1(sqrtA, sqrtB, amount1);
}

function getAmountsForLiquidity(
  sqrtPriceX96: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtPriceX96 <= sqrtA) {
    const amount0 = (liquidity * Q96 * (sqrtB - sqrtA)) / (sqrtA * sqrtB);
    return { amount0, amount1: 0n };
  }
  if (sqrtPriceX96 >= sqrtB) {
    const amount1 = (liquidity * (sqrtB - sqrtA)) / Q96;
    return { amount0: 0n, amount1 };
  }
  const amount0 = (liquidity * Q96 * (sqrtB - sqrtPriceX96)) / (sqrtPriceX96 * sqrtB);
  const amount1 = (liquidity * (sqrtPriceX96 - sqrtA)) / Q96;
  return { amount0, amount1 };
}

// ── Encoding helpers ──

function encodeMintParams(
  tickLower: number, tickUpper: number, liquidity: bigint,
  amount0Max: bigint, amount1Max: bigint, owner: Address,
): Hex {
  return encodeAbiParameters(
    [POOL_KEY_ABI, { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" }],
    [{ currency0, currency1, fee: FEE, tickSpacing: TICK_SPACING, hooks: HOOKS }, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, "0x"],
  );
}

function encodeSettlePairParams(): Hex {
  return encodeAbiParameters([{ type: "address" }, { type: "address" }], [currency0, currency1]);
}

function encodeTakePairParams(to: Address): Hex {
  return encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [currency0, currency1, to]);
}

function buildUnlockData(actions: number[], params: Hex[]): Hex {
  const actionsHex = ("0x" + actions.map((a) => a.toString(16).padStart(2, "0")).join("")) as Hex;
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actionsHex, params]);
}

// ── Main ──

async function main() {
  console.log(`\n=== Simulating LP position on Arbitrum ===`);
  console.log(`Vault: ${VAULT_ADDRESS}`);

  // 1. Get vault owner
  const owner = await client.readContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "owner",
  }) as Address;
  console.log(`Vault owner: ${owner}`);

  // 2. Check vault XAUT + USDT balances
  const [xautBal, usdtBal] = await Promise.all([
    client.readContract({ address: XAUT, abi: ERC20_ABI, functionName: "balanceOf", args: [VAULT_ADDRESS] }),
    client.readContract({ address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [VAULT_ADDRESS] }),
  ]);
  console.log(`Vault XAUT balance: ${formatUnits(xautBal as bigint, XAUT_DECIMALS)} XAUT`);
  console.log(`Vault USDT balance: ${formatUnits(usdtBal as bigint, USDT_DECIMALS)} USDT`);

  // 3. Read pool slot0
  const slot = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [POOL_ID, POOLS_SLOT]),
  );
  const result = await client.readContract({
    address: POOL_MANAGER_ARB,
    abi: EXTSLOAD_ABI,
    functionName: "extsload",
    args: [slot],
  });
  const raw = BigInt(result);
  const sqrtPriceX96 = raw & ((1n << 160n) - 1n);
  const tickRaw = Number((raw >> 160n) & 0xFFFFFFn);
  const tick = tickRaw >= 0x800000 ? tickRaw - 0x1000000 : tickRaw;
  console.log(`\nPool state: sqrtPriceX96=${sqrtPriceX96}, tick=${tick}`);

  // Compute price from sqrtPriceX96
  // price = (sqrtPriceX96 / 2^96)^2 * 10^(dec0-dec1)
  const sqrtPriceFloat = Number(sqrtPriceX96) / Number(Q96);
  const priceRaw = sqrtPriceFloat * sqrtPriceFloat;
  // currency0 is XAUT, currency1 is USDT (both 6 decimals → dec0-dec1=0)
  console.log(`Price (currency1/currency0): ${priceRaw.toFixed(4)}`);
  // This means 1 XAUT ~ priceRaw USDT

  // 4. Build LP position: 5 USDT worth, narrow range
  const usdtAmount = parseUnits("5", USDT_DECIMALS);
  // Derive XAUT amount from USDT

  // Narrow range: ±500 ticks, symmetric around nearest tickSpacing multiple
  const center = Math.round(tick / TICK_SPACING) * TICK_SPACING;
  const half = Math.ceil(500 / TICK_SPACING) * TICK_SPACING;
  const tickLower = center - half;
  const tickUpper = center + half;
  console.log(`\nTick range: [${tickLower}, ${tickUpper}] (center=${center}, half=${half})`);

  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  console.log(`sqrtA: ${sqrtA}, sqrtB: ${sqrtB}`);

  // USDT = currency1, XAUT = currency0
  // Derive XAUT from USDT using liquidity math
  let amount0: bigint; // XAUT
  let amount1: bigint; // USDT

  amount1 = usdtAmount;
  if (sqrtPriceX96 <= sqrtA) {
    amount0 = 0n;
    console.log("Price below range — all currency0");
  } else {
    const sqrtPriceClamped = sqrtPriceX96 < sqrtB ? sqrtPriceX96 : sqrtB;
    const liq1 = getLiquidityForAmount1(sqrtA, sqrtPriceClamped, amount1);
    const amounts = getAmountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, liq1);
    amount0 = amounts.amount0;
    console.log(`Derived from ${formatUnits(amount1, USDT_DECIMALS)} USDT:`);
    console.log(`  XAUT needed: ${formatUnits(amount0, XAUT_DECIMALS)}`);
    console.log(`  Liquidity (from amount1): ${liq1}`);
  }

  // Compute final liquidity
  const liquidity = getLiquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, amount0, amount1);
  console.log(`\nFinal liquidity: ${liquidity}`);

  // Verify amounts
  const verifyAmounts = getAmountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, liquidity);
  console.log(`Verify — amount0 (XAUT): ${formatUnits(verifyAmounts.amount0, XAUT_DECIMALS)}`);
  console.log(`Verify — amount1 (USDT): ${formatUnits(verifyAmounts.amount1, USDT_DECIMALS)}`);

  if (liquidity === 0n) {
    console.error("\n❌ Computed liquidity is zero!");
    process.exit(1);
  }

  // Check vault has enough
  if (amount0 > (xautBal as bigint)) {
    console.warn(`\n⚠️  Warning: Vault doesn't have enough XAUT (need ${formatUnits(amount0, XAUT_DECIMALS)}, have ${formatUnits(xautBal as bigint, XAUT_DECIMALS)})`);
  }
  if (amount1 > (usdtBal as bigint)) {
    console.warn(`\n⚠️  Warning: Vault doesn't have enough USDT (need ${formatUnits(amount1, USDT_DECIMALS)}, have ${formatUnits(usdtBal as bigint, USDT_DECIMALS)})`);
  }

  // 5. Build the calldata
  const amount0Max = amount0 + amount0 / 100n;
  const amount1Max = amount1 + amount1 / 100n;

  const unlockData = buildUnlockData(
    [Actions.MINT_POSITION, Actions.SETTLE_PAIR],
    [
      encodeMintParams(tickLower, tickUpper, liquidity, amount0Max, amount1Max, VAULT_ADDRESS),
      encodeSettlePairParams(),
    ],
  );

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const calldata = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: "modifyLiquidities",
    args: [unlockData, deadline],
  });

  console.log(`\nCalldata length: ${calldata.length} chars`);
  console.log(`Calldata (first 100): ${calldata.slice(0, 100)}...`);
  console.log(`Selector: ${calldata.slice(0, 10)}`);

  // 6. Simulate via eth_call (from owner, to vault)
  console.log(`\n=== Simulating eth_call ===`);
  console.log(`from: ${owner} (vault owner)`);
  console.log(`to: ${VAULT_ADDRESS} (vault)`);

  try {
    await client.call({
      account: owner,
      to: VAULT_ADDRESS,
      data: calldata,
    });
    console.log(`\n✅ Simulation SUCCESS — calldata is valid!`);
  } catch (err: any) {
    console.log(`\n❌ Simulation FAILED`);
    if (err.cause?.data) {
      console.log(`Revert data: ${err.cause.data}`);
    }
    if (err.shortMessage) {
      console.log(`Error: ${err.shortMessage}`);
    }
    if (err.message) {
      // Print first 500 chars of the full message
      console.log(`Full error: ${err.message.slice(0, 500)}`);
    }

    // Try to decode the revert reason
    try {
      const revertData = err.cause?.data || err.data;
      if (revertData && typeof revertData === "string" && revertData.startsWith("0x")) {
        // Check for Error(string) — selector 0x08c379a0
        if (revertData.startsWith("0x08c379a0")) {
          const reason = Buffer.from(revertData.slice(138), "hex").toString("utf8").replace(/\0/g, "");
          console.log(`Decoded revert reason: "${reason}"`);
        }
        // Check for Panic(uint256) — selector 0x4e487b71
        else if (revertData.startsWith("0x4e487b71")) {
          const code = parseInt(revertData.slice(10, 74), 16);
          console.log(`Decoded panic code: ${code}`);
        }
      }
    } catch {
      // ignore decode errors
    }

    // Also try simulating directly to the PositionManager for comparison
    const POSM_ARB = "0xd88f38f930b7952f2db2432cb002e7abbf3dd869" as Address;
    const POSM_ABI = [{
      name: "modifyLiquidities",
      type: "function" as const,
      stateMutability: "payable" as const,
      inputs: [
        { name: "unlockData", type: "bytes" as const },
        { name: "deadline", type: "uint256" as const },
      ],
      outputs: [],
    }] as const;

    console.log(`\n=== DEBUG: Simulating directly on PositionManager ===`);
    console.log(`from: ${VAULT_ADDRESS} (vault as sender)`);
    console.log(`to: ${POSM_ARB} (PositionManager)`);

    try {
      await client.call({
        account: VAULT_ADDRESS,
        to: POSM_ARB,
        data: encodeFunctionData({
          abi: POSM_ABI,
          functionName: "modifyLiquidities",
          args: [unlockData, deadline],
        }),
      });
      console.log(`✅ Direct POSM simulation PASSED`);
    } catch (e2: any) {
      console.log(`❌ Direct POSM simulation also FAILED: ${e2.shortMessage ?? e2.message?.slice(0, 300)}`);
    }
  }
}

main().catch(console.error);
