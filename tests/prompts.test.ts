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

  it("pivots cleanly when the latest message has an explicit new domain", () => {
    const domains = detectDomains([
      { role: "user", content: "Long ETH with 5x leverage" },
      { role: "assistant", content: "Opened a long position." },
      { role: "user", content: "Now swap 1 ETH for USDC" },
    ]);
    expect(domains.has("swap")).toBe(true);
    expect(domains.has("gmx")).toBe(false);
  });

  it("preserves GMX context across short confirmations like 'yes'", () => {
    const domains = detectDomains([
      { role: "user", content: "Increase my LIT/USD long by 20000 USD" },
      { role: "assistant", content: "This will raise leverage. Proceed?" },
      { role: "user", content: "yes, it's ok" },
    ]);
    expect(domains.has("gmx")).toBe(true);
    expect(domains.has("swap")).toBe(true);
    expect(domains.has("vault")).toBe(true);
  });

  it("does not inherit stale domains when the latest message is explicit", () => {
    const domains = detectDomains([
      { role: "user", content: "Bridge 100 USDC to Arbitrum" },
      { role: "assistant", content: "Done." },
      { role: "user", content: "Swap 1 ETH for USDC" },
    ]);
    expect(domains.has("swap")).toBe(true);
    expect(domains.has("bridge")).toBe(false);
    expect(domains.has("gmx")).toBe(false);
  });

  it("allows both swap and GMX when the message explicitly mentions GMX trading", () => {
    const domains = detectDomains([{ role: "user", content: "Buy ETH on GMX" }]);
    expect(domains.has("swap")).toBe(true);
    expect(domains.has("gmx")).toBe(true);
  });

  it("classifies plain 'sync' requests as bridge domain", () => {
    const domains = detectDomains([{ role: "user", content: "sync 100 USDC from Base to Arbitrum" }]);
    expect(domains.has("bridge")).toBe(true);
    expect(domains.has("swap")).toBe(false);
  });

  it("classifies 'NAV sync' and 'sync nav' requests as bridge domain", () => {
    const syncNav = detectDomains([{ role: "user", content: "sync nav from Arbitrum to Ethereum" }]);
    expect(syncNav.has("bridge")).toBe(true);

    const navSync = detectDomains([{ role: "user", content: "NAV sync from Base to Optimism" }]);
    expect(navSync.has("bridge")).toBe(true);
  });

  it("classifies crosschain transfer requests as bridge domain", () => {
    const domains = detectDomains([{ role: "user", content: "bridge 3 WETH from Arbitrum to Ethereum" }]);
    expect(domains.has("bridge")).toBe(true);
    expect(domains.has("swap")).toBe(false);
  });
});
