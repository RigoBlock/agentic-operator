import { describe, it, expect } from "vitest";
import { app } from "../src/index.js";
import { getProtectedRoutes } from "../src/middleware/x402.js";

const TEST_ENV = { APP_ENV: "production" } as any;

describe("agent discovery metadata", () => {
  it("derives x402 endpoint prices from the payment route registry", async () => {
    const res = await app.request("/.well-known/x402.json", undefined, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const protectedRoutes = getProtectedRoutes() as Record<string, { accepts: Array<{ price: string }> }>;

    for (const endpoint of body.endpoints) {
      const key = `${endpoint.method.toUpperCase()} ${endpoint.path}`;
      const accept = protectedRoutes[key].accepts[0];
      const expectedPrice = accept.scheme === "upto"
        ? `up to ${accept.price} (billed by actual usage)`
        : accept.price;
      expect(endpoint.price).toBe(expectedPrice);
    }
    const chat = body.endpoints.find((e: any) => e.path === "/api/chat");
    expect(chat.price).toBe("up to $0.20 (billed by actual usage)");
    expect(body.endpoints.some((e: any) => e.method === "get" && e.path === "/api/tools" && e.price === "$0.0024")).toBe(true);
    expect(body.endpoints.some((e: any) => e.method === "post" && e.path === "/api/tools" && e.price === "$0.0025")).toBe(true);
  });

  it("publishes an llms.txt guide with operation-specific prices and discovery links", async () => {
    const res = await app.request("/llms.txt", undefined, TEST_ENV);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("POST /api/chat — up to $0.20 (billed by actual usage)");
    expect(text).toContain("GET /api/tools — $0.0024");
    expect(text).toContain("POST /api/tools — $0.0025");
    expect(text).toContain("https://trader.rigoblock.com/openapi.json");
    expect(text).toContain("https://trader.rigoblock.com/.well-known/x402.json");
    expect(text).toContain("Direct tool invocation is POST /api/tools?toolName={name}. Tool discovery is GET /api/tools.");
  });

  it("uses the existing PNG favicon in the AI plugin manifest", async () => {
    const res = await app.request("/.well-known/ai-plugin.json", undefined, TEST_ENV);
    const body = await res.json() as any;
    expect(body.logo_url).toBe("https://trader.rigoblock.com/favicon.png");
  });
});
