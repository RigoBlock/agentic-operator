/**
 * GRG staking simulation engine.
 *
 * Implements the model from staking-strategy.md:
 * - Simulates 0-10% AUM allocation range in 1% increments
 * - Enforces liquidity ceiling (max purchasable without >2% slippage)
 * - Calculates risk-adjusted yield with GRG volatility penalty
 * - Finds optimal allocation (smallest amount with best risk-adj yield)
 * - Reports community upside scenario (2-5× delegation multiplier)
 */

import type {
  StakingSimulationInput,
  StakingSimulationPoint,
  StakingRecommendation,
  StakingSimulationResult,
} from "./types.js";

/** Assumed annualized volatility for the GRG token (conservative estimate). */
const GRG_ANNUAL_VOLATILITY = 0.6; // 60%

/** Volatility penalty = half the squared volatility (variance / 2). */
const VOLATILITY_PENALTY = (GRG_ANNUAL_VOLATILITY ** 2) / 2;

/** Default epoch duration in days. */
const DEFAULT_EPOCH_DAYS = 7;

/** Operator minimum share of pool rewards (protocol parameter, 30%). */
const OPERATOR_MIN_SHARE = 0.3;

/** Conservative community multiplier for upside scenario. */
const COMMUNITY_MULTIPLIER = 3;

/** Allocation steps: 0%, 1%, 2%, … 10%. */
const STEPS = Array.from({ length: 11 }, (_, i) => i);

/**
 * Run the staking simulation and return the recommendation.
 */
export function simulateStaking(input: StakingSimulationInput): StakingSimulationResult {
  const {
    vaultAum,
    grgPrice,
    grgLiquidity,
    totalPoolStake,
    epochReward,
    epochDuration = DEFAULT_EPOCH_DAYS,
  } = input;

  const epochsPerYear = 365 / epochDuration;

  // Max GRG by AUM (10% cap)
  const maxByAumUsd = vaultAum * 0.1;
  const maxByAumGrg = maxByAumUsd / grgPrice;

  // Effective cap is the lower of AUM-based and liquidity-based
  const effectiveMaxGrg = Math.min(maxByAumGrg, grgLiquidity);

  const simulationResults: StakingSimulationPoint[] = [];
  let hitLiquidityCeiling = false;

  for (const pct of STEPS) {
    const allocationPct = pct;
    const allocationFraction = pct / 100;
    const grgCostUsd = vaultAum * allocationFraction;
    let grgAmount = grgCostUsd / grgPrice;

    // Enforce liquidity ceiling
    if (grgAmount > grgLiquidity) {
      grgAmount = grgLiquidity;
      hitLiquidityCeiling = true;
    }

    if (pct === 0 || grgCostUsd === 0) {
      simulationResults.push({
        allocationPct,
        grgAmount: 0,
        grgCostUsd: 0,
        annualYieldPct: 0,
        riskAdjustedYieldPct: 0,
        communityUpsideYieldPct: 0,
      });
      continue;
    }

    // Reward estimation: pool share of total rewards
    // poolStake = operator's GRG + totalPoolStake (existing)
    // The operator staking grgAmount increases the pool's total stake
    const poolStake = grgAmount;
    const poolShareOfTotal = poolStake / (totalPoolStake + poolStake);
    const rewardPerEpochGrg = epochReward * poolShareOfTotal;

    // Operator gets at least 30% (up to 100% if no community delegation)
    // Conservative scenario: no community delegation → operator gets 100%
    const operatorRewardPerEpoch = rewardPerEpochGrg; // 100% if solo staker
    const annualRewardGrg = operatorRewardPerEpoch * epochsPerYear;
    const annualRewardUsd = annualRewardGrg * grgPrice;
    const annualYieldPct = (annualRewardUsd / grgCostUsd) * 100;

    // Risk-adjusted: subtract volatility penalty (in percentage points)
    const riskAdjustedYieldPct = annualYieldPct - VOLATILITY_PENALTY * 100;

    // Community upside: assume community delegates COMMUNITY_MULTIPLIER × operator stake
    const communityStake = grgAmount * COMMUNITY_MULTIPLIER;
    const totalPoolStakeWithCommunity = poolStake + communityStake;
    const communityShareOfTotal =
      totalPoolStakeWithCommunity / (totalPoolStake + totalPoolStakeWithCommunity);
    const communityRewardPerEpoch = epochReward * communityShareOfTotal;
    // Operator gets ~70% when community is present (1 - OPERATOR_MIN_SHARE for community)
    // Actually: community gets ≥30%, operator gets ≤70% of enlarged pool
    const operatorCommunityReward = communityRewardPerEpoch * (1 - OPERATOR_MIN_SHARE);
    const communityAnnualRewardUsd = operatorCommunityReward * epochsPerYear * grgPrice;
    const communityUpsideYieldPct = (communityAnnualRewardUsd / grgCostUsd) * 100;

    simulationResults.push({
      allocationPct,
      grgAmount,
      grgCostUsd,
      annualYieldPct,
      riskAdjustedYieldPct,
      communityUpsideYieldPct,
    });

    // Stop if we hit the liquidity ceiling — higher allocations not feasible
    if (hitLiquidityCeiling) break;
  }

  // Find optimal allocation: smallest % with best risk-adjusted yield.
  // The yield % is constant (reward share is proportional to stake), so
  // any positive allocation has the same yield %. Pick the smallest one
  // that's positive.
  const positiveResults = simulationResults.filter(
    (r) => r.riskAdjustedYieldPct > 0,
  );

  let recommendation: StakingRecommendation;

  if (positiveResults.length === 0) {
    // No positive risk-adjusted yield — don't stake
    recommendation = {
      optimalAllocationPct: 0,
      grgAmount: 0,
      grgCostUsd: 0,
      estimatedAnnualYieldPct: 0,
      estimatedAnnualRewardGrg: 0,
      estimatedAnnualRewardUsd: 0,
      riskAdjustedYieldPct: 0,
      communityUpsideYieldPct: 0,
      liquidityCeiling: grgLiquidity,
      liquidityUtilizationPct: 0,
    };
  } else {
    // Optimal = smallest allocation with positive risk-adjusted yield
    // Since yield % is essentially flat, we pick the minimum allocation (1%)
    const optimal = positiveResults[0];
    const annualRewardGrg =
      (optimal.annualYieldPct / 100) * optimal.grgCostUsd / grgPrice;

    recommendation = {
      optimalAllocationPct: optimal.allocationPct,
      grgAmount: optimal.grgAmount,
      grgCostUsd: optimal.grgCostUsd,
      estimatedAnnualYieldPct: optimal.annualYieldPct,
      estimatedAnnualRewardGrg: annualRewardGrg,
      estimatedAnnualRewardUsd: annualRewardGrg * grgPrice,
      riskAdjustedYieldPct: optimal.riskAdjustedYieldPct,
      communityUpsideYieldPct: optimal.communityUpsideYieldPct,
      liquidityCeiling: grgLiquidity,
      liquidityUtilizationPct: (optimal.grgAmount / grgLiquidity) * 100,
    };
  }

  return {
    recommendation,
    simulationResults,
    constraints: {
      maxByLiquidity: `${grgLiquidity.toFixed(0)} GRG (on-chain limit)`,
      maxByAum: `${maxByAumGrg.toFixed(0)} GRG (10% of AUM)`,
      effectiveMax: `${effectiveMaxGrg.toFixed(0)} GRG`,
      chainId: 1,
      note: "GRG must be purchased on Ethereum or bridged from another chain",
    },
  };
}
