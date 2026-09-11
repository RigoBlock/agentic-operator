/**
 * Regression coverage for the prod incident: an Arbitrum → BSC USDC NAV-sync
 * deposit (0xad22c0a9…) was built and broadcast even though its destination
 * fill reverts on-chain (NavManipulationDetected ±1 wei, the ECrosschain.sol
 * exact-equality NAV rounding bug) and its relay fee (~$0.02) covered ~10% of
 * the real BSC fill gas (~$0.21). The deposit sat in the AIntents escrow
 * until the Across dataworker refunded it hours later.
 *
 * Root cause in the worker: `simulateDepositV3ForMessage` returned `null` on
 * ANY failure and both builders silently continued with the optimistic
 * message-less quote (`if (simResult)`), and Phase 2 was skipped entirely
 * when no operatorAddress was provided (Tier-1 unsigned flow) — so the
 * underpriced deposit could still be built.
 *
 * Expected behavior now:
 *  - The simulation failure is fatal: the build rejects with
 *    "Source-chain simulation failed on <chain>: …" instead of producing
 *    a deposit that cannot fill.
 *  - Phase 2 always runs; without an authenticated operator the simulation
 *    sender is derived from the on-chain vault owner (getVaultInfo).
 *  - When the Across API rejects the destination fill simulation, the build
 *    rejects with "Destination fill simulation failed on <chain>: …"
 *    carrying the decoded revert reason (NavManipulationDetected).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from "viem";

const mockGetVaultTokenBalance = vi.hoisted(() => vi.fn());
const mockGetVaultInfo = vi.hoisted(() => vi.fn());

vi.mock("../src/services/vault.js", () => ({
  getVaultTokenBalance: mockGetVaultTokenBalance,
  getVaultTokenBalancesBulk: vi.fn(),
  getPoolData: vi.fn(),
  getVaultInfo: mockGetVaultInfo,
}));

process.env.ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "test-alchemy-key";

const { buildCrosschainTransfer } = await import("../src/services/crosschain.js");

// Arbitrary addresses — the incident vault/owner are named in the header comment.
const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const OWNER = "0x2222222222222222222222222222222222222222" as Address;
const FUNDS_DEPOSITED_TOPIC =
  "0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3";

const SUGGESTED_FEES_OK = {
  totalRelayFee: { pct: "0.0001", total: "100000000000000" },
  timestamp: "1788988559",
  estimatedFillTimeSec: 60,
  exclusiveRelayer: "0x0000000000000000000000000000000000000000",
  exclusivityDeadline: 0,
  spokePoolAddress: "0xe35e2862eec091f63fda495fcfd42407fbf8502a",
  isAmountTooLow: false,
  outputAmount: "999000000000000000",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** Build a callTracer frame whose nested SpokePool frame emits FundsDeposited. */
function traceFrameWithDeposit(message: Hex) {
  const data = encodeAbiParameters(
    parseAbiParameters(
      "bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 recipient, bytes32 exclusiveRelayer, bytes message",
    ),
    [
      ("0x" + "0".repeat(24) + "82aF49447D8a07e3bd95BD0d56f35241523fBab1".toLowerCase()) as Hex,
      ("0x" + "0".repeat(24) + "2170Ed0880ac9A755fd29B2688956BD959F933F8".toLowerCase()) as Hex,
      1000000000000000000n,
      999000000000000000n,
      1788988559,
      1788989159,
      0,
      ("0x" + "0".repeat(24) + VAULT.slice(2).toLowerCase()) as Hex,
      "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
      message,
    ],
  );
  return {
    type: "CALL",
    from: VAULT,
    to: VAULT,
    input: "0x",
    calls: [
      {
        type: "CALL",
        from: VAULT,
        to: "0xe35e2862eec091f63fda495fcfd42407fbf8502a",
        input: "0x",
        logs: [{ address: "0xe35e2862eec091f63fda495fcfd42407fbf8502a", topics: [FUNDS_DEPOSITED_TOPIC], data }],
      },
    ],
  };
}

const traceFrameWithoutDeposit = {
  type: "CALL",
  from: OWNER,
  to: VAULT,
  input: "0x",
  calls: [],
};

/** SIMULATION_ERROR body as the Across API returns it for a reverting fill. */
function simulationErrorBody() {
  const inner =
    "549eefae" + // NavManipulationDetected(uint256,uint256)
    "0".repeat(63) + "1" + // expectedAssets
    "0".repeat(63) + "2"; // netTotalValue
  return JSON.stringify({
    type: "AcrossApiError",
    code: "SIMULATION_ERROR",
    status: 400,
    message: `execution reverted: 0x${inner}`,
  });
}

describe("buildCrosschainTransfer — destination-fill simulation is fatal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    mockGetVaultTokenBalance.mockResolvedValue({ balance: 10_000_000_000_000_000_000n });
    mockGetVaultInfo.mockResolvedValue({
      address: VAULT,
      name: "Test Pool",
      symbol: "TP",
      owner: OWNER,
      totalSupply: "1000",
      decimals: 18,
    });
  });

  it("rejects when the depositV3 trace yields no FundsDeposited event, deriving the sender from the vault owner", async () => {
    const fetchMock = vi.mocked(fetch);
    // 1) initial suggested-fees quote, 2) debug_traceCall without the event
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SUGGESTED_FEES_OK))
      .mockResolvedValueOnce(jsonResponse({ result: traceFrameWithoutDeposit }));

    // No operatorAddress — the builder must fall back to the on-chain owner.
    await expect(
      buildCrosschainTransfer({
        vaultAddress: VAULT,
        srcChainId: 42161,
        dstChainId: 56,
        tokenSymbol: "WETH",
        amount: "1",
      }),
    ).rejects.toThrow(/Source-chain simulation failed on Arbitrum: FundsDeposited event not found in trace/);

    // The owner was looked up and used as the simulation sender…
    expect(mockGetVaultInfo).toHaveBeenCalledWith(42161, VAULT);
    // …and no deposit was built: exactly two fetches (quote + trace), no
    // re-quote with a fabricated message.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects with the decoded revert reason when Across cannot simulate the destination fill", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SUGGESTED_FEES_OK))
      .mockResolvedValueOnce(jsonResponse({ result: traceFrameWithDeposit("0xdeadbeef" as Hex) }))
      .mockResolvedValueOnce(new Response(simulationErrorBody(), { status: 400 }));

    await expect(
      buildCrosschainTransfer({
        vaultAddress: VAULT,
        srcChainId: 42161,
        dstChainId: 56,
        tokenSymbol: "WETH",
        amount: "1",
        operatorAddress: OWNER,
      }),
    ).rejects.toThrow(/Destination fill simulation failed on BNB Chain:.*NavManipulationDetected/s);

    // With an authenticated operator the owner lookup is unnecessary.
    expect(mockGetVaultInfo).not.toHaveBeenCalled();
    // quote → trace → re-quote (the failing one): no calldata is returned.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
