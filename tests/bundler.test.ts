/**
 * Bundler tests — Alchemy Smart Wallet execution helpers.
 *
 * These tests mock the Alchemy SDK and verify:
 *   - Chain-agnostic wallet API calls are routed to chain-specific endpoints
 *   - waitForCallsStatus timeouts are surfaced as pending results with callId
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address, Hex } from "viem";

const mockAlchemyTransport = vi.hoisted(() => vi.fn());
const mockCreateSmartWalletClient = vi.hoisted(() => vi.fn());
const mockLocalAccountSigner = vi.hoisted(() => vi.fn());

vi.mock("@account-kit/infra", () => ({
  alchemy: mockAlchemyTransport,
  mainnet: { id: 1, name: "Ethereum", rpcUrls: { alchemy: { http: ["https://eth-mainnet.g.alchemy.com/v2"] } } },
  optimism: { id: 10, name: "Optimism", rpcUrls: { alchemy: { http: ["https://opt-mainnet.g.alchemy.com/v2"] } } },
  polygon: { id: 137, name: "Polygon", rpcUrls: { alchemy: { http: ["https://polygon-mainnet.g.alchemy.com/v2"] } } },
  base: { id: 8453, name: "Base", rpcUrls: { alchemy: { http: ["https://base-mainnet.g.alchemy.com/v2"] } } },
  arbitrum: { id: 42161, name: "Arbitrum", rpcUrls: { alchemy: { http: ["https://arb-mainnet.g.alchemy.com/v2"] } } },
  bsc: { id: 56, name: "BNB Chain", rpcUrls: { alchemy: { http: ["https://bnb-mainnet.g.alchemy.com/v2"] } } },
  sepolia: { id: 11155111, name: "Sepolia", rpcUrls: { alchemy: { http: ["https://eth-sepolia.g.alchemy.com/v2"] } } },
  baseSepolia: { id: 84532, name: "Base Sepolia", rpcUrls: { alchemy: { http: ["https://base-sepolia.g.alchemy.com/v2"] } } },
  unichainMainnet: { id: 130, name: "Unichain", rpcUrls: { alchemy: { http: ["https://unichain-mainnet.g.alchemy.com/v2"] } } },
}));

vi.mock("@account-kit/wallet-client", () => ({
  createSmartWalletClient: mockCreateSmartWalletClient,
}));

vi.mock("@aa-sdk/core", () => ({
  LocalAccountSigner: mockLocalAccountSigner,
}));

import { executeSponsoredCalls } from "../src/services/bundler.js";

const AGENT_ACCOUNT = {
  address: "0xAgentWallet000000000000000000000000000000" as Address,
  type: "local",
  signMessage: vi.fn(),
  signTypedData: vi.fn(),
  signTransaction: vi.fn(),
  source: "custom",
} as unknown as import("viem/accounts").LocalAccount;

const CALL: import("../src/services/bundler.js").WalletCall = {
  to: "0xVault000000000000000000000000000000000000" as Address,
  data: "0xdeadbeef" as Hex,
  value: "0x0" as Hex,
};

function makeMockClient(overrides: {
  prepareCalls?: () => Promise<unknown>;
  signPreparedCalls?: () => Promise<unknown>;
  sendPreparedCalls?: () => Promise<{ id: string }>;
  waitForCallsStatus?: () => Promise<unknown>;
} = {}) {
  return {
    prepareCalls: overrides.prepareCalls || vi.fn().mockResolvedValue({ prepared: true }),
    signPreparedCalls: overrides.signPreparedCalls || vi.fn().mockResolvedValue({ signed: true }),
    sendPreparedCalls: overrides.sendPreparedCalls || vi.fn().mockResolvedValue({ id: "0xcallid" }),
    waitForCallsStatus: overrides.waitForCallsStatus || vi.fn().mockResolvedValue({ status: "success", receipts: [] }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLocalAccountSigner.mockImplementation(function () {
    return { getAddress: vi.fn().mockResolvedValue(AGENT_ACCOUNT.address) };
  });
});

describe("executeSponsoredCalls chain-specific routing", () => {
  it.each([
    [1, "eth-mainnet"],
    [10, "opt-mainnet"],
    [56, "bnb-mainnet"],
    [130, "unichain-mainnet"],
    [137, "polygon-mainnet"],
    [8453, "base-mainnet"],
    [42161, "arb-mainnet"],
    [11155111, "eth-sepolia"],
    [84532, "base-sepolia"],
  ])("routes wallet API calls to chain-specific Alchemy endpoint for chain %i", async (chainId, slug) => {
    mockCreateSmartWalletClient.mockReturnValue(makeMockClient());

    await executeSponsoredCalls(AGENT_ACCOUNT, chainId, "test-key", "policy-id", [CALL]);

    expect(mockAlchemyTransport).toHaveBeenCalledTimes(1);
    const alchemyConfig = mockAlchemyTransport.mock.calls[0][0];
    expect(alchemyConfig.apiKey).toBe("test-key");
    expect(alchemyConfig.chainAgnosticUrl).toBe(`https://${slug}.g.alchemy.com/v2`);
    expect(alchemyConfig.fetchOptions.headers.Origin).toBe("https://trader.rigoblock.com");
  });
});

describe("executeSponsoredCalls waitForCallsStatus timeout", () => {
  it("returns a pending result when waitForCallsStatus times out", async () => {
    const callId = "0xabcd1234";
    const timeoutError = Object.assign(new Error("Timed out while waiting for call bundle"), {
      name: "WaitForCallsStatusTimeoutError",
    });

    mockCreateSmartWalletClient.mockReturnValue(
      makeMockClient({
        sendPreparedCalls: vi.fn().mockResolvedValue({ id: callId }),
        waitForCallsStatus: vi.fn().mockRejectedValue(timeoutError),
      }),
    );

    const result = await executeSponsoredCalls(AGENT_ACCOUNT, 42161, "test-key", "policy-id", [CALL]);

    expect(result.callId).toBe(callId);
    expect(result.status).toBe("pending");
    expect(result.receipts).toBeUndefined();
  });

  it("re-throws non-timeout waitForCallsStatus errors", async () => {
    const otherError = new Error("Some bundler error");

    mockCreateSmartWalletClient.mockReturnValue(
      makeMockClient({
        sendPreparedCalls: vi.fn().mockResolvedValue({ id: "0xcallid" }),
        waitForCallsStatus: vi.fn().mockRejectedValue(otherError),
      }),
    );

    await expect(
      executeSponsoredCalls(AGENT_ACCOUNT, 42161, "test-key", "policy-id", [CALL]),
    ).rejects.toThrow("Some bundler error");
  });

  it("uses a 60s timeout on Ethereum mainnet", async () => {
    const waitForCallsStatus = vi.fn().mockResolvedValue({ status: "success", receipts: [] });
    mockCreateSmartWalletClient.mockReturnValue(makeMockClient({ waitForCallsStatus }));

    await executeSponsoredCalls(AGENT_ACCOUNT, 1, "test-key", "policy-id", [CALL]);

    expect(waitForCallsStatus).toHaveBeenCalledWith(
      expect.objectContaining({ pollingInterval: 4_000, timeout: 60_000 }),
    );
  });

  it("uses a 20s timeout on L2s", async () => {
    const waitForCallsStatus = vi.fn().mockResolvedValue({ status: "success", receipts: [] });
    mockCreateSmartWalletClient.mockReturnValue(makeMockClient({ waitForCallsStatus }));

    await executeSponsoredCalls(AGENT_ACCOUNT, 42161, "test-key", "policy-id", [CALL]);

    expect(waitForCallsStatus).toHaveBeenCalledWith(
      expect.objectContaining({ pollingInterval: 4_000, timeout: 20_000 }),
    );
  });
});
