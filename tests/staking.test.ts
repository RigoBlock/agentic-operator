/**
 * GRG Staking tests — calldata encoding for all staking operations.
 */
import { describe, it, expect } from "vitest";
import {
  buildStakeCalldata,
  buildUndelegateStakeCalldata,
  buildUnstakeCalldata,
  buildEndEpochCalldata,
  buildWithdrawDelegatorRewardsCalldata,
} from "../src/services/grgStaking.js";
import { STAKING_PROXY } from "../src/config.js";

describe("buildStakeCalldata", () => {
  it("encodes stake(uint256) with correct selector", () => {
    const data = buildStakeCalldata("100");
    // stake(uint256) selector = 0xa694fc3a
    expect(data.slice(0, 10)).toBe("0xa694fc3a");
  });

  it("encodes amount in 18 decimals", () => {
    const data = buildStakeCalldata("1");
    // 1e18 = 0xde0b6b3a7640000 (padded to 32 bytes)
    expect(data).toContain("0de0b6b3a7640000");
  });
});

describe("buildUndelegateStakeCalldata", () => {
  it("encodes undelegateStake(uint256) with correct selector", () => {
    const data = buildUndelegateStakeCalldata("50");
    // undelegateStake(uint256) = 0x4aace835
    expect(data.slice(0, 10)).toBe("0x4aace835");
  });
});

describe("buildUnstakeCalldata", () => {
  it("encodes unstake(uint256) with correct selector", () => {
    const data = buildUnstakeCalldata("50");
    // unstake(uint256) = 0x2e17de78
    expect(data.slice(0, 10)).toBe("0x2e17de78");
  });
});

describe("buildEndEpochCalldata", () => {
  it("encodes endEpoch() against staking proxy ABI (not vault ABI)", () => {
    const data = buildEndEpochCalldata();
    // endEpoch() selector = 0x0b9663db
    expect(data.slice(0, 10)).toBe("0x0b9663db");
  });

  it("has only the 4-byte selector (no arguments)", () => {
    const data = buildEndEpochCalldata();
    expect(data).toBe("0x0b9663db");
  });
});

describe("buildWithdrawDelegatorRewardsCalldata", () => {
  it("encodes withdrawDelegatorRewards() with correct selector", () => {
    const data = buildWithdrawDelegatorRewardsCalldata();
    // withdrawDelegatorRewards() = 0xb880660b
    expect(data.slice(0, 10)).toBe("0xb880660b");
  });

  it("has only the 4-byte selector (no arguments)", () => {
    const data = buildWithdrawDelegatorRewardsCalldata();
    expect(data).toBe("0xb880660b");
  });
});

describe("STAKING_PROXY addresses", () => {
  it("staking proxy for Ethereum is correct (from v3-contracts)", () => {
    expect(STAKING_PROXY[1]).toBe("0x730dDf7b602dB822043e0409d8926440395e07fE");
  });

  it("staking proxy for Base is correct", () => {
    expect(STAKING_PROXY[8453]).toBe("0xc758Ea84d6D978fe86Ee29c1fbD47B4F302F1992");
  });

  it("staking proxy for Arbitrum is correct", () => {
    expect(STAKING_PROXY[42161]).toBe("0xD495296510257DAdf0d74846a8307bf533a0fB48");
  });
});
