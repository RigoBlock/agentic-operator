/**
 * x402 Bazaar Discovery Extension Validation
 *
 * Ensures every PROTECTED_ROUTE declares a Bazaar extension that passes the
 * official SDK validation after method enrichment. This catches the common
 * failure mode where the extension uses a description map instead of a real
 * inputSchema, which agentic.market reports as "Input schema present: no".
 */
import { describe, it, expect } from "vitest";
import {
  bazaarResourceServerExtension,
  validateDiscoveryExtension,
} from "@x402/extensions/bazaar";
import { PROTECTED_ROUTES } from "../src/middleware/x402.js";

function createMockAdapter(method: string, path: string) {
  return {
    getHeader: () => undefined,
    getMethod: () => method,
    getPath: () => path,
    getUrl: () => `https://trader.rigoblock.com${path}`,
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "test",
    getQueryParams: () => ({}),
    getQueryParam: () => undefined,
  };
}

function enrichDeclaration(
  declaration: Record<string, unknown>,
  method: string,
  path: string,
) {
  const enrich = bazaarResourceServerExtension.enrichDeclaration;
  expect(enrich).toBeDefined();
  return enrich!(declaration, {
    method,
    adapter: createMockAdapter(method, path),
  });
}

describe("x402 Bazaar discovery extensions", () => {
  for (const [key, config] of Object.entries(PROTECTED_ROUTES)) {
    const [method, ...pathParts] = key.split(" ");
    const path = pathParts.join(" ");

    it(`${key} declares a valid Bazaar extension`, () => {
      const extensions = config.extensions ?? {};
      const bazaar = (extensions as Record<string, unknown>).bazaar;
      expect(bazaar).toBeDefined();
      expect(bazaar).toHaveProperty("info");
      expect(bazaar).toHaveProperty("schema");

      const enriched = enrichDeclaration(bazaar as Record<string, unknown>, method, path);
      const result = validateDiscoveryExtension(enriched as any);
      expect(result.valid).toBe(true);
      if (!result.valid) {
        expect(result.errors).toEqual([]);
      }
    });
    it(`${key} declares service metadata for CDP search indexing`, () => {
      expect(config.serviceName).toBeTruthy();
      expect(config.iconUrl).toMatch(/^https:\/\//);
      expect(Array.isArray(config.tags)).toBe(true);
      expect(config.tags!.length).toBeGreaterThan(0);
      expect(config.tags!.length).toBeLessThanOrEqual(10);
      for (const tag of config.tags!) {
        expect(typeof tag).toBe("string");
        expect(tag.length).toBeGreaterThan(0);
        expect(tag.length).toBeLessThanOrEqual(50);
      }
    });
  }
});
