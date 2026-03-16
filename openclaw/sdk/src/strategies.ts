/**
 * Strategy orchestration engines for the Rigoblock OpenClaw skill.
 *
 * Each strategy is a sequence of atomic API calls via RigoblockClient.
 * The agent uses these as building blocks — they return descriptions
 * of what happened (or needs to happen) at each step.
 */

import { RigoblockClient } from "./client.js";
import { simulateStaking } from "./staking.js";
import type {
  CarryTradeParams,
  LpHedgeParams,
  GrgStakingParams,
  ChatResponse,
  QuoteResponse,
  StakingSimulationResult,
} from "./types.js";

// ─── Strategy step result ───────────────────────────────────────────────────

export interface StrategyStep {
  action: string;
  result: ChatResponse | QuoteResponse | StakingSimulationResult | null;
  error?: string;
}

export interface StrategyResult {
  strategy: string;
  steps: StrategyStep[];
  success: boolean;
  summary: string;
}

// ─── Carry Trade (Arbitrum — single chain) ──────────────────────────────────

const CARRY_TRADE_DEFAULTS: CarryTradeParams = {
  allocation: 0.5,
  hedgeRatio: 1.0,
  rebalanceThreshold: 0.02,
  minFundingRate: 0.00005,
  exitAfterNegativeHours: 6,
};

/**
 * Enter the XAUT carry trade: buy spot gold + open short perp on GMX.
 * Both legs on Arbitrum. The result is a delta-neutral position earning
 * funding fees from the short perp.
 */
export async function enterCarryTrade(
  client: RigoblockClient,
  params: Partial<CarryTradeParams> = {},
): Promise<StrategyResult> {
  const cfg = { ...CARRY_TRADE_DEFAULTS, ...params };
  const steps: StrategyStep[] = [];

  // 1. Check vault USDT balance
  const info = await safeStep(steps, "Check vault info on Arbitrum", () =>
    client.vaultInfo("arbitrum"),
  );
  if (!info) return fail("carry-trade", steps, "Could not read vault info");

  // 2. Check existing GMX positions
  await safeStep(steps, "Check existing GMX positions", () =>
    client.gmxPositions(),
  );

  // 3. Get XAUT price
  const quote = await safeStep(steps, "Get XAUT/USDT price", () =>
    client.getQuote({ sell: "USDT", buy: "XAUT", amount: "1000", chain: "arbitrum" }),
  );
  if (!quote) return fail("carry-trade", steps, "Could not get XAUT quote");

  // 4. Buy XAUT spot — allocation % of available USDT
  const spotResult = await safeStep(
    steps,
    `Swap USDT → XAUT (${(cfg.allocation * 100).toFixed(0)}% allocation)`,
    () => client.swap("USDT", "XAUT", `${cfg.allocation * 100}%`, "arbitrum"),
  );
  if (!spotResult) return fail("carry-trade", steps, "Spot purchase failed");

  // 5. Open short XAUT/USD on GMX at 1x leverage
  const perpResult = await safeStep(
    steps,
    "Open 1x short XAUT/USD on GMX (delta hedge)",
    () =>
      client.gmxOpen(
        "XAUT/USD",
        "short",
        "USDT",
        `match spot value * ${cfg.hedgeRatio}`,
        1,
      ),
  );
  if (!perpResult) return fail("carry-trade", steps, "Perp hedge failed");

  // 6. Verify final state
  await safeStep(steps, "Verify GMX positions", () => client.gmxPositions());

  return {
    strategy: "carry-trade",
    steps,
    success: true,
    summary: "Carry trade entered: long XAUT spot + short XAUT/USD perp on Arbitrum",
  };
}

/**
 * Exit the carry trade: close perp, sell spot, return to USDT.
 */
export async function exitCarryTrade(
  client: RigoblockClient,
): Promise<StrategyResult> {
  const steps: StrategyStep[] = [];

  await safeStep(steps, "Close XAUT/USD short on GMX", () =>
    client.gmxClose("XAUT/USD", "short"),
  );

  await safeStep(steps, "Swap XAUT → USDT on Arbitrum", () =>
    client.swap("XAUT", "USDT", "all", "arbitrum"),
  );

  await safeStep(steps, "Verify vault state", () => client.vaultInfo("arbitrum"));

  return {
    strategy: "carry-trade",
    steps,
    success: true,
    summary: "Carry trade exited: sold spot XAUT, closed perp hedge",
  };
}

// ─── LP + Hedge (Ethereum LP ↔ Arbitrum hedge) ─────────────────────────────

const LP_HEDGE_DEFAULTS: LpHedgeParams = {
  xautAllocation: 0.4,
  bridgeAllocation: 0.1,
  lpRange: "wide",
  hedgeRatio: 1.0,
  rebalanceThreshold: 0.02,
  maxHedgeCost: -0.0001,
};

/**
 * Enter LP+Hedge strategy:
 *   1. On Ethereum: buy XAUT → add XAUT/USDT LP
 *   2. Bridge USDT to Arbitrum → buy XAUT → open short on GMX
 */
export async function enterLpHedge(
  client: RigoblockClient,
  params: Partial<LpHedgeParams> = {},
): Promise<StrategyResult> {
  const cfg = { ...LP_HEDGE_DEFAULTS, ...params };
  const steps: StrategyStep[] = [];

  // 1. Check vault USDT on Ethereum
  const info = await safeStep(steps, "Check vault info on Ethereum", () =>
    client.vaultInfo("ethereum"),
  );
  if (!info) return fail("lp-hedge", steps, "Could not read vault info");

  // 2. Swap USDT → XAUT on Ethereum (using 0x for best routing)
  await safeStep(
    steps,
    `Swap USDT → XAUT (${(cfg.xautAllocation * 100).toFixed(0)}% allocation) via 0x on Ethereum`,
    () =>
      client.chat(
        `swap ${(cfg.xautAllocation * 100).toFixed(0)}% of USDT for XAUT using 0x on ethereum`,
      ),
  );

  // 3. Add LP position on Uniswap v4
  await safeStep(
    steps,
    "Add XAUT/USDT liquidity on Uni v4 (Ethereum)",
    () =>
      client.chat(
        `add liquidity to XAUT/USDT pool with available XAUT and matching USDT on ethereum, ${cfg.lpRange} range`,
      ),
  );

  // 4. Bridge USDT to Arbitrum for hedge collateral
  await safeStep(
    steps,
    `Bridge USDT to Arbitrum (${(cfg.bridgeAllocation * 100).toFixed(0)}% for hedge)`,
    () =>
      client.chat(
        `bridge ${(cfg.bridgeAllocation * 100).toFixed(0)}% of USDT from ethereum to arbitrum`,
      ),
  );

  // 5. Convert bridged USDT to XAUT on Arbitrum
  await safeStep(
    steps,
    "Swap USDT → XAUT on Arbitrum (hedge collateral)",
    () => client.swap("USDT", "XAUT", "all bridged USDT", "arbitrum"),
  );

  // 6. Open short XAUT/USD on GMX with XAUT collateral
  await safeStep(
    steps,
    "Open 1x short XAUT/USD on GMX with XAUT collateral",
    () =>
      client.gmxOpen(
        "XAUT/USD",
        "short",
        "XAUT",
        "all available XAUT on Arbitrum",
        1,
      ),
  );

  // 7. Verify
  await safeStep(steps, "Verify GMX positions", () => client.gmxPositions());
  await safeStep(steps, "Check aggregated NAV", () => client.aggregatedNav());

  return {
    strategy: "lp-hedge",
    steps,
    success: true,
    summary:
      "LP+Hedge entered: XAUT/USDT LP on Ethereum + short XAUT/USD hedge on Arbitrum",
  };
}

/**
 * Exit LP+Hedge: close hedge → bridge back → remove LP → convert to USDT.
 */
export async function exitLpHedge(
  client: RigoblockClient,
): Promise<StrategyResult> {
  const steps: StrategyStep[] = [];

  // 1. Close hedge on Arbitrum
  await safeStep(steps, "Close XAUT/USD short on GMX", () =>
    client.gmxClose("XAUT/USD", "short"),
  );

  // 2. Convert XAUT back to USDT on Arbitrum
  await safeStep(steps, "Swap XAUT → USDT on Arbitrum", () =>
    client.swap("XAUT", "USDT", "all", "arbitrum"),
  );

  // 3. Bridge USDT back to Ethereum
  await safeStep(steps, "Bridge USDT from Arbitrum to Ethereum", () =>
    client.bridge("USDT", "all", "arbitrum", "ethereum"),
  );

  // 4. Remove LP on Ethereum
  await safeStep(steps, "Remove XAUT/USDT LP position on Ethereum", () =>
    client.chat("remove all XAUT/USDT LP positions on ethereum"),
  );

  // 5. Sell remaining XAUT
  await safeStep(steps, "Swap remaining XAUT → USDT on Ethereum", () =>
    client.swap("XAUT", "USDT", "all", "ethereum"),
  );

  // 6. Verify
  await safeStep(steps, "Verify final vault state", () => client.vaultInfo());

  return {
    strategy: "lp-hedge",
    steps,
    success: true,
    summary: "LP+Hedge exited: closed hedge, removed LP, consolidated to USDT",
  };
}

// ─── GRG Staking ────────────────────────────────────────────────────────────

const GRG_STAKING_DEFAULTS: GrgStakingParams = {
  maxAllocationPct: 0.1,
  slippageTolerance: 0.02,
  rebalanceEpochs: 4,
};

export interface StakingEntryInput {
  params?: Partial<GrgStakingParams>;
  /** Market data for simulation — caller must provide these */
  vaultAum: number;
  grgPrice: number;
  grgLiquidity: number;
  totalPoolStake: number;
  epochReward: number;
}

/**
 * Enter GRG staking: simulate optimal allocation, purchase GRG, stake.
 */
export async function enterGrgStaking(
  client: RigoblockClient,
  input: StakingEntryInput,
): Promise<StrategyResult> {
  const cfg = { ...GRG_STAKING_DEFAULTS, ...input.params };
  const steps: StrategyStep[] = [];

  // 1. Simulate optimal allocation
  const simulation = simulateStaking({
    vaultAum: input.vaultAum,
    grgPrice: input.grgPrice,
    grgLiquidity: input.grgLiquidity,
    totalPoolStake: input.totalPoolStake,
    epochReward: input.epochReward,
  });

  steps.push({
    action: "Simulate optimal GRG staking allocation",
    result: simulation,
  });

  const { recommendation } = simulation;

  // Respect max allocation cap
  const effectivePct = Math.min(
    recommendation.optimalAllocationPct / 100,
    cfg.maxAllocationPct,
  );

  if (effectivePct <= 0) {
    return {
      strategy: "grg-staking",
      steps,
      success: true,
      summary: "Staking simulation: optimal allocation is 0% — no staking recommended",
    };
  }

  // 2. Check GRG balance on Ethereum
  const info = await safeStep(steps, "Check vault info on Ethereum", () =>
    client.vaultInfo("ethereum"),
  );
  if (!info) return fail("grg-staking", steps, "Could not read vault info");

  // 3. Purchase GRG if needed
  const grgNeeded = recommendation.grgAmount;
  await safeStep(
    steps,
    `Purchase ${grgNeeded.toFixed(0)} GRG on Ethereum`,
    () => client.swap("USDC", "GRG", grgNeeded.toFixed(0), "ethereum"),
  );

  // 4. Stake GRG
  await safeStep(steps, `Stake ${grgNeeded.toFixed(0)} GRG`, () =>
    client.stakeGrg(grgNeeded.toFixed(0)),
  );

  return {
    strategy: "grg-staking",
    steps,
    success: true,
    summary: `GRG staking: allocated ${(effectivePct * 100).toFixed(1)}% AUM → ${grgNeeded.toFixed(0)} GRG staked (est. ${recommendation.estimatedAnnualYieldPct.toFixed(2)}% annual yield)`,
  };
}

// ─── Strategy Compositor ────────────────────────────────────────────────────

export interface CompositorInput {
  /** Available USDT across all chains */
  totalUsdt: number;
  /** Current GMX funding rate for XAUT/USD (hourly) */
  xautFundingRate: number;
  /** Current LP APR estimate for XAUT/USDT pool */
  lpApr: number;
  /** GRG staking simulation input */
  stakingInput: Omit<StakingEntryInput, "params">;
}

export interface CompositorResult {
  recommendation: {
    carryTrade: { allocate: boolean; pctOfCapital: number; expectedApr: number };
    lpHedge: { allocate: boolean; pctOfCapital: number; expectedApr: number };
    grgStaking: { allocate: boolean; pctOfCapital: number; expectedApr: number };
    reserve: { pctOfCapital: number };
  };
  reasoning: string;
}

/**
 * Score and rank all three strategies. Returns allocation recommendations.
 * Does NOT execute — the agent uses this to decide what to enter.
 */
export function composeStrategy(input: CompositorInput): CompositorResult {
  // Annualize funding rate: hourly rate * 24 * 365
  const carryApr = input.xautFundingRate * 24 * 365 * 100;

  // Net LP yield = LP fees − hedge funding cost
  // Hedge cost is funding rate (negative if we're paying)
  const hedgeCost = Math.abs(
    Math.min(0, input.xautFundingRate) * 24 * 365 * 100,
  );
  const lpNetApr = input.lpApr - hedgeCost;

  // Staking yield from simulation
  const stakingResult = simulateStaking({
    vaultAum: input.stakingInput.vaultAum,
    grgPrice: input.stakingInput.grgPrice,
    grgLiquidity: input.stakingInput.grgLiquidity,
    totalPoolStake: input.stakingInput.totalPoolStake,
    epochReward: input.stakingInput.epochReward,
  });
  const stakingApr = stakingResult.recommendation.riskAdjustedYieldPct;
  const stakingPct = stakingResult.recommendation.optimalAllocationPct / 100;

  // Score: only allocate to positive-yield strategies
  const strategies = [
    { name: "carry-trade" as const, apr: carryApr, eligible: carryApr > 0 },
    { name: "lp-hedge" as const, apr: lpNetApr, eligible: lpNetApr > 1 },
    { name: "grg-staking" as const, apr: stakingApr, eligible: stakingApr > 0 },
  ];

  const eligible = strategies.filter((s) => s.eligible);

  // Allocate capital
  let reservePct = 0.15; // 15% default reserve
  const stakingAlloc = stakingPct > 0 ? Math.min(stakingPct, 0.1) : 0;

  let carryAlloc = 0;
  let lpAlloc = 0;
  const deployable = 1 - reservePct - stakingAlloc;

  if (eligible.some((s) => s.name === "carry-trade") && eligible.some((s) => s.name === "lp-hedge")) {
    // Both viable — split based on relative yield
    const carryScore = Math.max(0, carryApr);
    const lpScore = Math.max(0, lpNetApr);
    const total = carryScore + lpScore;
    if (total > 0) {
      carryAlloc = (carryScore / total) * deployable;
      lpAlloc = (lpScore / total) * deployable;
    }
  } else if (eligible.some((s) => s.name === "carry-trade")) {
    carryAlloc = deployable;
  } else if (eligible.some((s) => s.name === "lp-hedge")) {
    lpAlloc = deployable;
  } else {
    // No yield strategies viable — all to reserve
    reservePct = 1 - stakingAlloc;
  }

  const reasoning = [
    `Carry trade: ${carryApr > 0 ? "✓" : "✗"} APR ${carryApr.toFixed(2)}% (funding rate ${(input.xautFundingRate * 100).toFixed(4)}%/h)`,
    `LP+Hedge: ${lpNetApr > 1 ? "✓" : "✗"} net APR ${lpNetApr.toFixed(2)}% (LP ${input.lpApr.toFixed(2)}% − hedge cost ${hedgeCost.toFixed(2)}%)`,
    `GRG Staking: ${stakingApr > 0 ? "✓" : "✗"} risk-adj APR ${stakingApr.toFixed(2)}%, optimal ${(stakingPct * 100).toFixed(1)}% AUM`,
    `Reserve: ${(reservePct * 100).toFixed(0)}% kept in USDT`,
  ].join("\n");

  return {
    recommendation: {
      carryTrade: {
        allocate: carryAlloc > 0,
        pctOfCapital: carryAlloc,
        expectedApr: carryApr,
      },
      lpHedge: {
        allocate: lpAlloc > 0,
        pctOfCapital: lpAlloc,
        expectedApr: lpNetApr,
      },
      grgStaking: {
        allocate: stakingAlloc > 0,
        pctOfCapital: stakingAlloc,
        expectedApr: stakingApr,
      },
      reserve: { pctOfCapital: reservePct },
    },
    reasoning,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function safeStep<T extends ChatResponse | QuoteResponse>(
  steps: StrategyStep[],
  action: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    const result = await fn();
    steps.push({ action, result });
    return result;
  } catch (e) {
    steps.push({
      action,
      result: null,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

function fail(strategy: string, steps: StrategyStep[], reason: string): StrategyResult {
  return { strategy, steps, success: false, summary: `Failed: ${reason}` };
}
