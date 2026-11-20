import { describe, it, expect } from "vitest";
import {
  extractLighterReqIdFromReceipt,
  LIGHTER_ORDER_SENT_TOPIC,
} from "../public/frontend/lighter-receipt-core.js";

const REQ_ID_TOPIC = `0x${(6067n).toString(16).padStart(64, "0")}`;

describe("extractLighterReqIdFromReceipt", () => {
  it("extracts the indexed OrderSent reqId", () => {
    const receipt = {
      logs: [
        { topics: ["0x83a48fbcfc991335314e74d0496aab6a1987e992ddc85dddbcc4d6dd6ef2e9fc", "0xabc"] },
        { topics: [LIGHTER_ORDER_SENT_TOPIC, REQ_ID_TOPIC] },
      ],
    };
    expect(extractLighterReqIdFromReceipt(receipt)).toBe("6067");
  });

  it("returns null when no OrderSent event exists", () => {
    expect(extractLighterReqIdFromReceipt({ logs: [] })).toBeNull();
    expect(extractLighterReqIdFromReceipt({ logs: [{ topics: ["0xabc"] }] })).toBeNull();
  });
});
