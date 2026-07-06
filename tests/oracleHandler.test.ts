/**
 * Oracle handler tests — focused on input validation for handle_refresh_oracle_feed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockBuildTx } = vi.hoisted(() => ({
  mockBuildTx: vi.fn(),
}));

vi.mock("../src/services/oraclePool.js", () => ({
  buildOraclePoolSwapTx: mockBuildTx,
  UNIVERSAL_ROUTER: {},
}));

vi.mock("../src/llm/client.js", () => ({
  estimateGas: vi.fn().mockResolvedValue("0x5208"),
}));

const { mockGetTokenDecimals, mockGetClient } = vi.hoisted(() => ({
  mockGetTokenDecimals: vi.fn(),
  mockGetClient: vi.fn(),
}));

vi.mock("../src/services/vault.js", () => ({
  getTokenDecimals: mockGetTokenDecimals,
  getClient: mockGetClient,
}));

import { handle_refresh_oracle_feed } from "../src/llm/handlers/oracle.js";
import type { Env, RequestContext } from "../src/types.js";

function mockEnv(): Env {
  return {
    ASSETS: {} as any,
    KV: {} as any,
    UNISWAP_API_KEY: "test-uniswap",
    ZEROX_API_KEY: "test-0x",
    ALCHEMY_API_KEY: "test-alchemy",
    CDP_API_KEY_ID: "test-cdp-id",
    CDP_API_KEY_SECRET: "test-cdp-secret",
    CDP_WALLET_SECRET: "test-cdp-wallet",
  } as Env;
}

function mockCtx(chainId: number, vaultAddress?: string): RequestContext {
  return {
    chainId,
    vaultAddress: (vaultAddress || "0x0000000000000000000000000000000000000000") as `0x${string}`,
    operatorAddress: "0x1111111111111111111111111111111111111111",
    isBrowserRequest: false,
  };
}

describe("handle_refresh_oracle_feed native-token guard", () => {
  beforeEach(() => {
    mockBuildTx.mockReset();
  });

  it("rejects POL as token on Polygon", async () => {
    await expect(
      handle_refresh_oracle_feed(
        mockEnv(),
        mockCtx(137),
        { token: "POL", direction: "sell", amount: "10" },
        "refresh_oracle_feed",
      ),
    ).rejects.toThrow(/POL is the native token/);
    expect(mockBuildTx).not.toHaveBeenCalled();
  });

  it("rejects MATIC legacy symbol on Polygon", async () => {
    await expect(
      handle_refresh_oracle_feed(
        mockEnv(),
        mockCtx(137),
        { token: "MATIC", direction: "buy", amount: "0.01" },
        "refresh_oracle_feed",
      ),
    ).rejects.toThrow(/MATIC is the native token/);
    expect(mockBuildTx).not.toHaveBeenCalled();
  });

  it("rejects WPOL on Polygon", async () => {
    await expect(
      handle_refresh_oracle_feed(
        mockEnv(),
        mockCtx(137),
        { token: "WPOL", direction: "buy", amount: "0.01" },
        "refresh_oracle_feed",
      ),
    ).rejects.toThrow(/WPOL is the native token/);
    expect(mockBuildTx).not.toHaveBeenCalled();
  });

  it("rejects ETH as token on Base", async () => {
    await expect(
      handle_refresh_oracle_feed(
        mockEnv(),
        mockCtx(8453),
        { token: "ETH", direction: "sell", amount: "0.01" },
        "refresh_oracle_feed",
      ),
    ).rejects.toThrow(/ETH is the native token/);
    expect(mockBuildTx).not.toHaveBeenCalled();
  });

  it("rejects zero address as token", async () => {
    await expect(
      handle_refresh_oracle_feed(
        mockEnv(),
        mockCtx(8453),
        { token: "0x0000000000000000000000000000000000000000", direction: "buy", amount: "0.01" },
        "refresh_oracle_feed",
      ),
    ).rejects.toThrow(/native token/);
    expect(mockBuildTx).not.toHaveBeenCalled();
  });

  it("allows GRG as token on Polygon via vault", async () => {
    mockBuildTx.mockResolvedValueOnce({
      transaction: { to: "0xRouter", data: "0xabc", value: "0x0", gas: "0x5208" },
      poolInfo: { currency1: "0x333", tokenSymbol: "GRG" },
      amountInWei: 10000000000000000000n,
      tokenDecimals: 18,
      message: "ok",
    });

    const vaultAddress = "0x2222222222222222222222222222222222222222";
    const result = await handle_refresh_oracle_feed(
      mockEnv(),
      mockCtx(137, vaultAddress),
      { token: "GRG", direction: "sell", amount: "10", viaVault: true },
      "refresh_oracle_feed",
    );

    expect(mockBuildTx).toHaveBeenCalledWith(
      "GRG",
      "10",
      137,
      "test-alchemy",
      vaultAddress,
      "sell",
    );
    expect(result.message).toBe("ok");
  });

  it("estimates token input from native amountOut on sell direction", async () => {
    // User says "buy 1 POL" (receive 1 POL) → sell GRG. amountOut=1 POL should
    // be parsed with 18 decimals and trigger a convertTokenAmount estimate.
    mockGetTokenDecimals.mockResolvedValueOnce(18);
    mockGetClient.mockReturnValueOnce({
      readContract: vi.fn().mockResolvedValueOnce(10n * 10n ** 18n), // 10 GRG needed for 1 POL
    });
    mockBuildTx.mockResolvedValueOnce({
      transaction: { to: "0xRouter", data: "0xabc", value: "0x0", gas: "0x5208" },
      poolInfo: { currency1: "0x333", tokenSymbol: "GRG" },
      amountInWei: 10500000000000000000n,
      tokenDecimals: 18,
      message: "ok",
    });

    const vaultAddress = "0x2222222222222222222222222222222222222222";
    await handle_refresh_oracle_feed(
      mockEnv(),
      mockCtx(137, vaultAddress),
      { token: "GRG", direction: "sell", amountOut: "1", viaVault: true },
      "refresh_oracle_feed",
    );

    // The estimate is 10 GRG; we add 5% buffer → 10.5 GRG.
    expect(mockBuildTx).toHaveBeenCalledWith(
      "GRG",
      "10.5",
      137,
      "test-alchemy",
      vaultAddress,
      "sell",
    );
  });
});
