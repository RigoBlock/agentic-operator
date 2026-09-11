/**
 * Tests for describeAcrossApiError — the SIMULATION_ERROR decoding that
 * turns the raw Across API hex blob into the real revert reason.
 *
 * Regression context (prod, Arbitrum → BSC USDC NAV sync): the worker
 * surfaced `Across API error (400): {"type":"AcrossApiError","code":
 * "SIMULATION_ERROR",...0xe462c440...` — opaque to operators. The actual
 * cause was NavManipulationDetected at destination-call index 3 (the vault's
 * exact-equality NAV check differing by 1 wei).
 */
import { describe, it, expect } from "vitest";
import { describeAcrossApiError } from "../src/services/crosschain.js";

// Full revert payload: CallReverted(3, calls[4]) — as returned by the
// MulticallHandler when destination call 3 (donate) reverts. The calls array
// contains the donate selector 0x6da7df96; here we simulate an inner
// NavManipulationDetected (0x549eefae) appearing in the payload.
const CALL_REVERTED_WITH_NAV = () => {
  const idx = 3n;
  const head =
    "e462c440" +
    idx.toString(16).padStart(64, "0") + // callIndex = 3
    (128n).toString(16).padStart(64, "0") + // offset to calls
    (4n).toString(16).padStart(64, "0"); // calls length
  const inner =
    "549eefae" +
    "0".repeat(63) + "1" + // expectedAssets
    "0".repeat(63) + "2"; // netTotalValue
  const callEntry =
    "0".repeat(24) + "1111111111111111111111111111111111111111" + // target — arbitrary vault address; decoding does not depend on the value
    (32n + BigInt(inner.length / 2)).toString(16).padStart(64, "0") + // data len
    inner.padEnd(64, "0");
  const callsArr = (4n).toString(16).padStart(64, "0") + callEntry;
  return "0x" + head + callsArr;
};

function simErrorBody(revertHex: string) {
  return JSON.stringify({
    type: "AcrossApiError",
    code: "SIMULATION_ERROR",
    status: 400,
    message: `execution reverted: ${revertHex}`,
  });
}

describe("describeAcrossApiError", () => {
  it("decodes SIMULATION_ERROR with CallReverted + inner NavManipulationDetected", () => {
    const msg = describeAcrossApiError(400, simErrorBody(CALL_REVERTED_WITH_NAV()));
    expect(msg).toContain("CallReverted at call 3");
    expect(msg).toContain("NavManipulationDetected");
    expect(msg).toContain("no funds move");
    expect(msg).not.toContain("0xe462c440");
  });

  it("names a bare inner selector without the CallReverted wrapper", () => {
    const body = simErrorBody(
      "0x549eefae" + "0".repeat(63) + "1" + "0".repeat(63) + "2",
    );
    const msg = describeAcrossApiError(400, body);
    expect(msg).toContain("NavManipulationDetected");
  });

  it("keeps a readable message for non-simulation Across errors", () => {
    const body = JSON.stringify({
      type: "AcrossApiError",
      code: "INVALID_ROUTE",
      status: 400,
      message: "route not enabled",
    });
    const msg = describeAcrossApiError(400, body);
    expect(msg).toContain("Across API error (400)");
    expect(msg).toContain("INVALID_ROUTE");
    expect(msg).toContain("route not enabled");
  });

  it("falls back to slicing non-JSON bodies", () => {
    const msg = describeAcrossApiError(502, "<html>bad gateway</html>");
    expect(msg).toContain("Across API error (502)");
    expect(msg).toContain("<html>");
  });
});
