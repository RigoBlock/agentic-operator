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

const { mockGetTokenDecimals, mockGetClient, mockIsVaultOnChain } = vi.hoisted(() => ({
  mockGetTokenDecimals: vi.fn(),
  mockGetClient: vi.fn(),
  mockIsVaultOnChain: vi.fn(),
}));

vi.mock("../src/services/vault.js", () => ({
  getTokenDecimals: mockGetTokenDecimals,
  isVaultOnChain: mockIsVaultOnChain,
}));

vi.mock("../src/services/rpcClient.js", () => ({
  getRpcProvider: mockGetClient,
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
    mockGetTokenDecimals.mockReset();
    mockGetClient.mockReset();
    mockIsVaultOnChain.mockReset();
    // Default: assume the connected vault address is valid on whatever chain we end up on.
    // Tests that need a cross-chain mismatch override this per-call.
    mockIsVaultOnChain.mockResolvedValue(true);
    // Default RPC client for EOA-path pre-flight checks (balance / allowance).
    // Tests that need specific RPC responses override this per-call.
    mockGetClient.mockReturnValue({
      multicall: vi.fn().mockResolvedValue([
        { status: "success", result: 1000000000000000000000n },
        { status: "success", result: 1000000000000000000000n },
      ]),
      getBalance: vi.fn().mockResolvedValue(1000000000000000000000n),
    });
  });

  it("rejects POL as token on Polygon", async () => {
    await expect(
      handle_refresh_oracle_feed(
        mockEnv(),
        mockCtx(137),
        { token: "POL", tokenIn: "POL", tokenOut: "GRG", amount: "10" },
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
        { token: "MATIC", tokenIn: "GRG", tokenOut: "MATIC", amount: "0.01" },
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
        { token: "WPOL", tokenIn: "WPOL", tokenOut: "GRG", amount: "0.01" },
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
        { token: "ETH", tokenIn: "GRG", tokenOut: "ETH", amount: "0.01" },
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
        { token: "0x0000000000000000000000000000000000000000", tokenIn: "ETH", tokenOut: "GRG", amount: "0.01" },
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
      { token: "GRG", tokenIn: "GRG", tokenOut: "POL", amount: "10", viaVault: true },
      "refresh_oracle_feed",
    );

    expect(mockBuildTx).toHaveBeenCalledWith(
      "GRG",
      "10",
      137,

      vaultAddress,
      "sell",
    );
    expect(result.message).toBe("ok");
  });

  it("derives direction from tokenIn/tokenOut (native in)", async () => {
    mockBuildTx.mockResolvedValueOnce({
      transaction: { to: "0xRouter", data: "0xabc", value: "0x0", gas: "0x5208" },
      poolInfo: { currency1: "0x333", tokenSymbol: "GRG" },
      amountInWei: 1000000000000000000n,
      tokenDecimals: 18,
      message: "ok",
    });

    const vaultAddress = "0x2222222222222222222222222222222222222222";
    await handle_refresh_oracle_feed(
      mockEnv(),
      mockCtx(137, vaultAddress),
      { token: "GRG", tokenIn: "POL", tokenOut: "GRG", amount: "1", viaVault: true },
      "refresh_oracle_feed",
    );

    // tokenIn=POL (native), tokenOut=GRG → buy GRG with 1 POL.
    expect(mockBuildTx).toHaveBeenCalledWith(
      "GRG",
      "1",
      137,

      vaultAddress,
      "buy",
    );
  });

  it("derives direction from tokenIn/tokenOut (native out)", async () => {
    mockBuildTx.mockResolvedValueOnce({
      transaction: { to: "0xRouter", data: "0xabc", value: "0x0", gas: "0x5208" },
      poolInfo: { currency1: "0x333", tokenSymbol: "GRG" },
      amountInWei: 10000000000000000000n,
      tokenDecimals: 18,
      message: "ok",
    });

    const vaultAddress = "0x2222222222222222222222222222222222222222";
    await handle_refresh_oracle_feed(
      mockEnv(),
      mockCtx(137, vaultAddress),
      { token: "GRG", tokenIn: "GRG", tokenOut: "POL", amount: "10", viaVault: true },
      "refresh_oracle_feed",
    );

    // tokenIn=GRG, tokenOut=POL → sell 10 GRG.
    expect(mockBuildTx).toHaveBeenCalledWith(
      "GRG",
      "10",
      137,

      vaultAddress,
      "sell",
    );
  });

  it("rejects when neither amount nor amountOut is provided", async () => {
    await expect(
      handle_refresh_oracle_feed(
        mockEnv(),
        mockCtx(137, "0x2222222222222222222222222222222222222222"),
        { token: "GRG", tokenIn: "GRG", tokenOut: "POL", viaVault: true },
        "refresh_oracle_feed",
      ),
    ).rejects.toThrow(/oracle pool swap size cannot be defaulted/);
    expect(mockBuildTx).not.toHaveBeenCalled();
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
      { token: "GRG", tokenIn: "GRG", tokenOut: "POL", amountOut: "1", viaVault: true },
      "refresh_oracle_feed",
    );

    // The estimate is 10 GRG; we add 5% buffer → 10.5 GRG.
    expect(mockBuildTx).toHaveBeenCalledWith(
      "GRG",
      "10.5",
      137,

      vaultAddress,
      "sell",
    );
  });

  it("rejects amountOut when the vault is not on the target chain", async () => {
    mockIsVaultOnChain.mockResolvedValueOnce(false);

    const vaultAddress = "0x2222222222222222222222222222222222222222";
    await expect(
      handle_refresh_oracle_feed(
        mockEnv(),
        mockCtx(8453, vaultAddress),
        { token: "GRG", tokenIn: "GRG", tokenOut: "POL", amountOut: "1" },
        "refresh_oracle_feed",
      ),
    ).rejects.toThrow(/amountOut requires a connected vault on Polygon/);
    expect(mockBuildTx).not.toHaveBeenCalled();
  });

  it("falls back to the operator wallet when the connected vault is not on the inferred chain", async () => {
    mockIsVaultOnChain.mockResolvedValueOnce(false); // 0x2222… vault is not on Polygon
    mockBuildTx.mockResolvedValueOnce({
      transaction: {
        to: "0xRouter",
        data: "0xabc",
        value: "0x0",
        gas: "0x5208",
        operatorOnly: true,
      },
      poolInfo: { currency1: "0x333", tokenSymbol: "GRG" },
      amountInWei: 1000000000000000000n,
      tokenDecimals: 18,
      message: "ok",
    });

    const vaultAddress = "0x2222222222222222222222222222222222222222";
    const ctx = mockCtx(8453, vaultAddress);
    const result = await handle_refresh_oracle_feed(
      mockEnv(),
      ctx,
      { token: "GRG", tokenIn: "GRG", tokenOut: "POL", amount: "1" },
      "refresh_oracle_feed",
    );

    // Even though the incoming context was Base, POL uniquely maps to Polygon.
    // The Base vault address must not be used as a Polygon vault, so we fall
    // back to the EOA/operator-wallet path.
    expect(mockIsVaultOnChain).toHaveBeenCalledWith(137, vaultAddress);
    expect(mockBuildTx).toHaveBeenCalledWith(
      "GRG",
      "1",
      137,

      undefined,
      "sell",
    );
    expect(ctx.chainId).toBe(137);
    expect(result.transaction).toMatchObject({ operatorOnly: true });
  });

  it("rejects explicit viaVault=true when the vault is not on the target chain", async () => {
    mockIsVaultOnChain.mockResolvedValueOnce(false);

    const vaultAddress = "0x2222222222222222222222222222222222222222";
    await expect(
      handle_refresh_oracle_feed(
        mockEnv(),
        mockCtx(8453, vaultAddress),
        { token: "GRG", tokenIn: "GRG", tokenOut: "POL", amount: "1", viaVault: true },
        "refresh_oracle_feed",
      ),
    ).rejects.toThrow(/not a valid vault on Polygon/);
    expect(mockBuildTx).not.toHaveBeenCalled();
  });
});
