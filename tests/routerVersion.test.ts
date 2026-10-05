/**
 * Router version resolution tests — the Uniswap Trading API router-version
 * header must follow the live Authority adapter mapping.
 *
 * Protocol invariant under test: the adapter deployed on each chain today is
 * the only UR 2.0-based one; any other adapter the Authority maps the swap
 * selector to (governance upgrade, bugfix redeploy to a fresh address) speaks
 * UR 2.1.2.
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

const UR2_ETHEREUM = "0x8d89AC596804704Fff512DAe5cAC19319F3AB560";
const UR2_ARBITRUM_LOWER = "0x27a707296078c535b8ecabc3a5e9b5e26a9c2140";
const UPGRADED_BASE = "0x1A279E75FCAE3EBC12Db496BB015fA6614A1Af74"; // governance upgrade
const REDEPLOYED = "0x2Df1A4914eDf32523A98469Cd97B473ba0741216"; // bugfix-style redeploy
const ZERO = "0x0000000000000000000000000000000000000000";

beforeEach(() => {
  vi.useRealTimers();
  mockReadContract.mockReset();
  mockGetRpcProvider.mockReset();
  mockGetRpcProvider.mockReturnValue({ readContract: mockReadContract });
});

describe("resolveUniversalRouterVersion", () => {
  it('returns "2.0" when the Authority maps the swap selector to the known UR 2.0 adapter', async () => {
    mockReadContract.mockResolvedValue(UR2_ETHEREUM);
    await expect(resolveUniversalRouterVersion(1)).resolves.toBe("2.0");
  });

  it('returns "2.0" for the UR 2.0 adapter regardless of checksum casing', async () => {
    mockReadContract.mockResolvedValue(UR2_ARBITRUM_LOWER);
    await expect(resolveUniversalRouterVersion(42161)).resolves.toBe("2.0");
  });

  it('returns "2.1.2" for the governance-upgrade adapter address', async () => {
    mockReadContract.mockResolvedValue(UPGRADED_BASE);
    await expect(resolveUniversalRouterVersion(8453)).resolves.toBe("2.1.2");
  });

  it('returns "2.1.2" for any unknown non-zero adapter (bugfix redeploy to a fresh address)', async () => {
    mockReadContract.mockResolvedValue(REDEPLOYED);
    await expect(resolveUniversalRouterVersion(10)).resolves.toBe("2.1.2");
  });

  it('defaults to "2.0" when the selector is unmapped', async () => {
    mockReadContract.mockResolvedValue(ZERO);
    await expect(resolveUniversalRouterVersion(56)).resolves.toBe("2.0");
  });

  it('defaults to "2.0" when the Authority read fails', async () => {
    mockReadContract.mockRejectedValue(new Error("RPC down"));
    await expect(resolveUniversalRouterVersion(137)).resolves.toBe("2.0");
  });

  it('defaults to "2.0" for chains with no known UR 2.0 adapter without any RPC call', async () => {
    await expect(resolveUniversalRouterVersion(999)).resolves.toBe("2.0");
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });

  it("caches the resolution within the TTL (one Authority read for two calls)", async () => {
    mockReadContract.mockResolvedValue(REDEPLOYED);
    await expect(resolveUniversalRouterVersion(130)).resolves.toBe("2.1.2");
    await expect(resolveUniversalRouterVersion(130)).resolves.toBe("2.1.2");
    expect(mockReadContract).toHaveBeenCalledTimes(1);
  });
});
