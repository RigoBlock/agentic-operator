import { describe, it, expect } from "vitest";
import { formatForTelegram } from "../src/services/telegram.js";

describe("formatForTelegram", () => {
  it("converts markdown tables to aligned <pre> blocks", () => {
    const input = [
      "| Market | Side | Size | Net Value |",
      "|--------|------|------|-----------|",
      "| LIT/USD | LONG | $43.00K | $9.00K |",
      "| ETH/USD | SHORT | $1.20M | $200.00K |",
    ].join("\n");

    const result = formatForTelegram(input);
    expect(result).toContain("<pre>");
    expect(result).toContain("</pre>");

    // Cells should be padded so the pipe separators line up.
    const pre = result.match(/<pre>([\s\S]*?)<\/pre>/)?.[1] ?? "";
    const rows = pre.split("\n");
    expect(rows.length).toBeGreaterThanOrEqual(3);

    // Each row should have the same pipe positions.
    const pipePositions = rows.map((r) =>
      Array.from(r).map((ch, i) => (ch === "|" ? i : -1)).filter((i) => i !== -1),
    );
    const first = pipePositions[0];
    for (const pos of pipePositions) {
      expect(pos).toEqual(first);
    }
  });

  it("right-aligns numeric columns", () => {
    const input = [
      "| Size | Net PnL |",
      "|------|---------|",
      "| $9.00K | +$3.64K (+68.02%) |",
      "| $43.00K | -$1.00K (-10.00%) |",
    ].join("\n");

    const result = formatForTelegram(input);
    const pre = result.match(/<pre>([\s\S]*?)<\/pre>/)?.[1] ?? "";
    const dataRows = pre.split("\n").filter((r) => r.includes("$9.00K") || r.includes("$43.00K"));
    expect(dataRows.length).toBe(2);
    // Right-aligned numeric values should have leading spaces when shorter than the column width.
    expect(dataRows[0]).toContain("  $9.00K");
  });

  it("left-aligns text columns", () => {
    const input = [
      "| Market | Side |",
      "|--------|------|",
      "| LIT/USD | LONG |",
      "| ETH/USD | SHORT |",
    ].join("\n");

    const result = formatForTelegram(input);
    const pre = result.match(/<pre>([\s\S]*?)<\/pre>/)?.[1] ?? "";
    expect(pre).toContain(" LIT/USD ");
    expect(pre).not.toContain("🟢");
  });

  it("does not right-align hex addresses", () => {
    const input = [
      "| Address | Balance |",
      "|---------|---------|",
      "| 0xabc123 | $1.00 |",
      "| 0xdef456 | $2.00 |",
    ].join("\n");

    const result = formatForTelegram(input);
    const pre = result.match(/<pre>([\s\S]*?)<\/pre>/)?.[1] ?? "";
    const addrRow = pre.split("\n").find((r) => r.includes("0xabc123")) ?? "";
    // Address should be left-aligned (starts right after "| " in its cell).
    expect(addrRow).toMatch(/\| 0xabc123\s+\|/);
  });
});
