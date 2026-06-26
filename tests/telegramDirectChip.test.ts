import { describe, it, expect } from "vitest";
import { parseTelegramDirectChip } from "../src/routes/telegram.js";

describe("parseTelegramDirectChip", () => {
  it("maps Refresh positions to gmx_get_positions", () => {
    const result = parseTelegramDirectChip("Refresh positions");
    expect(result).toEqual({ type: "tool", toolName: "gmx_get_positions", args: {} });
  });

  it("maps Show GMX markets to gmx_get_markets", () => {
    const result = parseTelegramDirectChip("Show GMX markets");
    expect(result).toEqual({ type: "tool", toolName: "gmx_get_markets", args: {} });
  });

  it("returns a direct reply for Open new position", () => {
    const result = parseTelegramDirectChip("Open new position");
    expect(result?.type).toBe("reply");
    expect((result as { text: string }).text).toContain("long 1000 ETHUSDC 5x");
  });

  it("returns a direct reply for Open a long", () => {
    const result = parseTelegramDirectChip("Open a long");
    expect(result?.type).toBe("reply");
    expect((result as { text: string }).text).toContain("long &lt;size&gt;");
  });

  it("returns a direct reply for Cancel order", () => {
    const result = parseTelegramDirectChip("Cancel order");
    expect(result?.type).toBe("reply");
    expect((result as { text: string }).text).toContain("cancel order 0xOrderKey");
  });

  it("returns null for unknown chips", () => {
    expect(parseTelegramDirectChip("Random chip")).toBeNull();
  });
});
