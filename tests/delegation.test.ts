/**
 * Delegation tests — selector map, default selectors, selective revocation.
 */
import { describe, it, expect } from "vitest";
import { ALLOWED_VAULT_SELECTORS, VAULT_DELEGATION_ABI } from "../src/abi/rigoblockVault.js";
import { buildDefaultSelectors } from "../src/services/delegation.js";

describe("ALLOWED_VAULT_SELECTORS", () => {
  it("contains all expected categories", () => {
    // Uniswap
    expect(ALLOWED_VAULT_SELECTORS.executeWithDeadline).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.execute).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.modifyLiquidities).toBeDefined();

    // 0x
    expect(ALLOWED_VAULT_SELECTORS.zeroXExecute).toBeDefined();

    // GMX v2
    expect(ALLOWED_VAULT_SELECTORS.cancelOrder).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.claimCollateral).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.claimFundingFees).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.createDecreaseOrder).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.createIncreaseOrder).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.updateOrder).toBeDefined();

    // Cross-chain (Across)
    expect(ALLOWED_VAULT_SELECTORS.depositV3).toBeDefined();

    // GRG Staking
    expect(ALLOWED_VAULT_SELECTORS.stake).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.undelegateStake).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.unstake).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.withdrawDelegatorRewards).toBeDefined();
  });

  it("all selectors are 4-byte hex strings (0x + 8 hex chars)", () => {
    for (const [name, selector] of Object.entries(ALLOWED_VAULT_SELECTORS)) {
      expect(selector, `Selector for ${name}`).toMatch(/^0x[a-fA-F0-9]{8}$/);
    }
  });

  it("has no duplicate selectors", () => {
    const values = Object.values(ALLOWED_VAULT_SELECTORS);
    const lowerValues = values.map((v) => v.toLowerCase());
    const unique = new Set(lowerValues);
    expect(unique.size).toBe(values.length);
  });

  it("has the correct GRG staking selectors from AStaking.sol interface", () => {
    // These were computed from the AStaking.sol function signatures
    expect(ALLOWED_VAULT_SELECTORS.stake).toBe("0xa694fc3a");           // stake(uint256)
    expect(ALLOWED_VAULT_SELECTORS.undelegateStake).toBe("0x4aace835"); // undelegateStake(uint256)
    expect(ALLOWED_VAULT_SELECTORS.unstake).toBe("0x2e17de78");         // unstake(uint256)
    expect(ALLOWED_VAULT_SELECTORS.withdrawDelegatorRewards).toBe("0xb880660b"); // withdrawDelegatorRewards()
  });

  it("does NOT include endEpoch (which is on the staking proxy, not the vault)", () => {
    const allKeys = Object.keys(ALLOWED_VAULT_SELECTORS);
    expect(allKeys).not.toContain("endEpoch");

    // Also verify the endEpoch selector itself isn't present under any name
    const values = Object.values(ALLOWED_VAULT_SELECTORS).map((v) => v.toLowerCase());
    expect(values).not.toContain("0x0b9663db"); // endEpoch()
  });

  it("does NOT include withdraw or transferOwnership (critical security)", () => {
    const allKeys = Object.keys(ALLOWED_VAULT_SELECTORS);
    expect(allKeys).not.toContain("withdraw");
    expect(allKeys).not.toContain("transferOwnership");
    expect(allKeys).not.toContain("setOwner");
    expect(allKeys).not.toContain("transfer");
  });
});

describe("buildDefaultSelectors", () => {
  it("returns all selectors from ALLOWED_VAULT_SELECTORS", () => {
    const defaults = buildDefaultSelectors();
    const allSelectors = Object.values(ALLOWED_VAULT_SELECTORS);
    expect(defaults).toHaveLength(allSelectors.length);
    for (const selector of allSelectors) {
      expect(defaults).toContain(selector);
    }
  });

  it("returns Hex[] values (0x-prefixed)", () => {
    const defaults = buildDefaultSelectors();
    for (const s of defaults) {
      expect(s).toMatch(/^0x[a-fA-F0-9]{8}$/);
    }
  });
});

describe("VAULT_DELEGATION_ABI", () => {
  it("includes updateDelegation function", () => {
    const fn = VAULT_DELEGATION_ABI.find(
      (entry) => "name" in entry && entry.name === "updateDelegation",
    );
    expect(fn).toBeDefined();
  });

  it("includes revokeAllDelegations function", () => {
    const fn = VAULT_DELEGATION_ABI.find(
      (entry) => "name" in entry && entry.name === "revokeAllDelegations",
    );
    expect(fn).toBeDefined();
  });

  it("includes getDelegatedSelectors view", () => {
    const fn = VAULT_DELEGATION_ABI.find(
      (entry) => "name" in entry && entry.name === "getDelegatedSelectors",
    );
    expect(fn).toBeDefined();
  });
});
