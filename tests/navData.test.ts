/**
 * getNavData tests.
 *
 * getNavData must eth_call the real updateUnitaryValue() — the same live
 * computation the NAV guard uses — pinned to an explicit block tag. (The old
 * ENavView extension is removed in newer protocol releases and is never used.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFunctionResult, type Address } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../src/abi/rigoblockVault.js";

const { mockCall } = vi.hoisted(() => ({ mockCall: vi.fn() }));

vi.mock("../src/services/rpcClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/rpcClient.js")>();
  return {
    ...actual,
    getRpcProvider: () => ({ call: mockCall }),
  };
});

const { getNavData } = await import("../src/services/vault.js");

const VAULT = "0x07816c517ccF14C64c7De3AeF88d638F12c1C9Be" as Address;

beforeEach(() => {
  vi.clearAllMocks();
  mockCall.mockResolvedValue({
    data: encodeFunctionResult({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "updateUnitaryValue",
      result: [1_000_000_000_000_000_000n, 35_000_000n, 0n] as never,
    }),
  });
});

describe("getNavData", () => {
  it("simulates updateUnitaryValue()", async () => {
    const nav = await getNavData(19529, VAULT);
    const callArgs = mockCall.mock.calls[0][0] as { to: Address; data: string; blockTag: string };
    // updateUnitaryValue() selector
    expect(callArgs.data.startsWith("0xe7d8724e")).toBe(true);
    expect(callArgs.blockTag).toBe("latest");
    expect(nav.unitaryValue).toBe(1_000_000_000_000_000_000n);
    expect(nav.totalValue).toBe(35_000_000n); // netTotalValue maps to totalValue
    expect(nav.timestamp).toBe(0n);
  });
});
