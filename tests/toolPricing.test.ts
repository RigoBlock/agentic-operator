import { describe, it, expect } from "vitest";
import { getProtectedRoutes } from "../src/middleware/x402.js";
import { getToolX402Price, DEFAULT_TOOL_X402_PRICE } from "../src/llm/tools.js";

describe("tool-owned x402 pricing", () => {
  it("derives protected route prices from the same tool definitions used by settlement", () => {
    const routes = getProtectedRoutes() as Record<string, { accepts: Array<{ price: string }> }>;
    const cases = [
      ["GET /api/quote", "get_swap_quote"],
      ["POST /api/oracle/refresh", "refresh_oracle_feed"],
      ["GET /api/tools", "get_tool_menu"],
    ] as const;

    for (const [route, toolName] of cases) {
      expect(routes[route].accepts[0].price).toBe(getToolX402Price(toolName));
    }
    expect(routes["POST /api/tools"].accepts[0].price).toBe(DEFAULT_TOOL_X402_PRICE);
  });

  it("uses a deployment-specific price, and the direct-tool default only when undeclared", () => {
    expect(getToolX402Price("deploy_smart_pool")).toBe("$0.0026");
    expect(getToolX402Price("some_future_tool")).toBe(DEFAULT_TOOL_X402_PRICE);
  });
});
