/**
 * Router version resolution tests — the Uniswap Trading API router-version
 * header must follow the live Authority adapter mapping.
 *
 * Mocks the RPC client: each test stubs getApplicationAdapter's return value
 * (or its failure) and asserts which x-universal-router-version results.
 * Distinct chainIds per test keep the module-level TTL cache from colliding.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockReadContract, mockGetRpcProvider } = vi.hoisted(() => ({
  mockReadContract: vi.fn(),
  mockGetRpcProvider: vi.fn(),
}));

vi.mock("../src/services/rpcClient.js", () => ({
  getRpcProvider: mockGetRpcProvider,
}));

import { resolveUniversalRouterVersion } from "../src/services/routerVersion.js";

const UPGRADED_ETHEREUM = "0x8e0f4cb68e276e31cf48b33eddd40325f5a736d2"; // all-lowercase

beforeEach(() => {
  vi.useRealTimers();
  mockReadContract.mockReset();
  mockGetRpcProvider.mockReset();
  mockGetRpcProvider.mockReturnValue({ readContract: mockReadContract });
});

describe("resolveUniversalRouterVersion", () => {
  it('returns "2.0" when the Authority maps the swap selector to the current adapter', async () => {
    mockReadContract.mockResolvedValue("0x2b75aD5cB2fa53fF93D20F38b5f3264Fbd1A6f82");
    await expect(resolveUniversalRouterVersion(8453)).resolves.toBe("2.0");
  });

  it('returns "2.1.2" when the Authority maps the swap selector to the upgraded adapter', async () => {
    // Lowercase return value must still match the checksummed table entry.
    mockReadContract.mockResolvedValue(UPGRADED_ETHEREUM);
    await expect(resolveUniversalRouterVersion(1)).resolves.toBe("2.1.2");
  });

  it('defaults to "2.0" when the Authority read fails', async () => {
    mockReadContract.mockRejectedValue(new Error("RPC down"));
    await expect(resolveUniversalRouterVersion(42161)).resolves.toBe("2.0");
  });

  it('defaults to "2.0" for an unknown adapter mapping with a warning, not a crash', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockReadContract.mockResolvedValue("0x00000000000000000000000000000000000000ff");
    await expect(resolveUniversalRouterVersion(10)).resolves.toBe("2.0");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('defaults to "2.0" for chains with no known adapter pair without any RPC call', async () => {
    await expect(resolveUniversalRouterVersion(999)).resolves.toBe("2.0");
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });

  it("caches the resolution within the TTL (one Authority read for two calls)", async () => {
    mockReadContract.mockResolvedValue("0x1b2bcb8833bbb6a9f1ec6e41003e5daeb18a534a");
    await expect(resolveUniversalRouterVersion(137)).resolves.toBe("2.1.2");
    await expect(resolveUniversalRouterVersion(137)).resolves.toBe("2.1.2");
    expect(mockReadContract).toHaveBeenCalledTimes(1);
  });
});
