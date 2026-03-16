/**
 * GRG Staking Service
 *
 * Builds unsigned transactions for GRG staking operations through the vault's
 * AStaking adapter. The vault routes calls to the Rigoblock staking proxy.
 *
 * Vault adapter operations (delegatable):
 *   - stake(uint256 amount)              → Lock GRG in the staking pool (auto-creates pool if needed)
 *   - undelegateStake(uint256 amount)    → Move stake from DELEGATED to UNDELEGATED (required before unstake)
 *   - unstake(uint256 amount)            → Withdraw undelegated GRG from the staking pool
 *   - withdrawDelegatorRewards()         → Claim delegator rewards back to vault
 *
 * Staking proxy operations (NOT delegatable — operator must sign directly):
 *   - endEpoch()                         → Finalize the current epoch (permissionless, anyone can call)
 *
 * Staking workflow:
 *   1. stake(amount) — stakes GRG, creates pool if first time, auto-delegates to self
 *   2. [earn rewards over epochs]
 *   3. undelegateStake(amount) — required before unstake (moves to UNDELEGATED status)
 *   4. [wait for epoch to end]
 *   5. unstake(amount) — withdraws GRG back to vault
 *
 * @see https://github.com/RigoBlock/v3-contracts/blob/development/contracts/protocol/extensions/adapters/AStaking.sol
 */

import { type Address, type Hex, encodeFunctionData, parseUnits } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";

/** GRG token has 18 decimals */
const GRG_DECIMALS = 18;

/** IStaking ABI fragment for endEpoch (called on staking proxy, not vault) */
const STAKING_ABI = [
  {
    name: "endEpoch",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Build calldata for vault.stake(amount).
 * The vault's AStaking adapter routes this to the staking proxy.
 */
export function buildStakeCalldata(amount: string): Hex {
  const amountWei = parseUnits(amount, GRG_DECIMALS);
  return encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "stake",
    args: [amountWei],
  });
}

/**
 * Build calldata for vault.undelegateStake(amount).
 * Must be called before unstake() — moves stake from DELEGATED to UNDELEGATED.
 */
export function buildUndelegateStakeCalldata(amount: string): Hex {
  const amountWei = parseUnits(amount, GRG_DECIMALS);
  return encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "undelegateStake",
    args: [amountWei],
  });
}

/**
 * Build calldata for vault.unstake(amount).
 * Stake must be in UNDELEGATED status first (call undelegateStake before this).
 */
export function buildUnstakeCalldata(amount: string): Hex {
  const amountWei = parseUnits(amount, GRG_DECIMALS);
  return encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "unstake",
    args: [amountWei],
  });
}

/**
 * Build calldata for stakingProxy.endEpoch().
 * This is called directly on the staking proxy contract, NOT through the vault adapter.
 * It's permissionless — anyone can call it to finalize the current epoch.
 * The operator must sign and send this transaction from their wallet.
 */
export function buildEndEpochCalldata(): Hex {
  return encodeFunctionData({
    abi: STAKING_ABI,
    functionName: "endEpoch",
    args: [],
  });
}

/**
 * Build calldata for vault.withdrawDelegatorRewards().
 * Claims accumulated delegator rewards back to the vault.
 */
export function buildWithdrawDelegatorRewardsCalldata(): Hex {
  return encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "withdrawDelegatorRewards",
    args: [],
  });
}
