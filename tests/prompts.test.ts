import { describe, it, expect } from "vitest";
import { detectDomains } from "../src/llm/prompts.js";

describe("detectDomains", () => {
  it("classifies a plain swap as swap only (no GMX leak)", () => {
    const domains = detectDomains([{ role: "user", content: "Swap 1 ETH for USDC on Base" }]);
    expect(domains.has("swap")).toBe(true);
    expect(domains.has("gmx")).toBe(false);
  });

  it("classifies leverage/perp requests as GMX", () => {
    const domains = detectDomains([{ role: "user", content: "Long ETH with 5x leverage" }]);
    expect(domains.has("gmx")).toBe(true);
    expect(domains.has("swap")).toBe(false);
  });

  it("does not treat generic 'position' or 'margin' as GMX", () => {
    const domains = detectDomains([{ role: "user", content: "Check my position" }]);
    expect(domains.has("gmx")).toBe(false);
    // Falls back to the default swap + vault domains
    expect(domains.has("swap")).toBe(true);
    expect(domains.has("vault")).toBe(true);
  });

  it("uses only the latest user message for detection", () => {
    const domains = detectDomains([
      { role: "user", content: "Long ETH with 5x leverage" },
      { role: "assistant", content: "Opened a long position." },
      { role: "user", content: "Now swap 1 ETH for USDC" },
    ]);
    expect(domains.has("swap")).toBe(true);
    expect(domains.has("gmx")).toBe(false);
  });

  it("allows both swap and GMX when the message explicitly mentions GMX trading", () => {
    const domains = detectDomains([{ role: "user", content: "Buy ETH on GMX" }]);
    expect(domains.has("swap")).toBe(true);
    expect(domains.has("gmx")).toBe(true);
  });
});
