/**
 * x402 Fail-Closed Safety Tests
 *
 * Ensures that /api/* routes not explicitly listed in PROTECTED_ROUTES
 * or PUBLIC_API_ROUTES are blocked with 503, rather than silently passing
 * through (which would confuse agents with 401 from the route's own auth).
 *
 * Safety invariant (enforced by src/middleware/x402.ts):
 *   IF processHTTPRequest returns "no-payment-required"
 *   AND the route is /api/* but NOT in PUBLIC_API_ROUTES
 *   THEN return 503.
 *
 * The full integration test would require mocking the @x402/core SDK,
 * which is brittle. The critical logic is covered by:
 *   1. isPublicApiRoute() unit tests (below)
 *   2. apiConsistency.test.ts — validates every discovered route is in
 *      PUBLIC_API_ROUTES or PROTECTED_ROUTES
 */
import { describe, it, expect } from "vitest";

describe("x402 middleware fail-closed logic", () => {
  it("isPublicApiRoute returns true only for explicitly public routes", async () => {
    const { isPublicApiRoute } = await import("../src/middleware/x402.js");

    expect(isPublicApiRoute("GET", "/api/health")).toBe(true);
    expect(isPublicApiRoute("GET", "/api/chains")).toBe(true);
    expect(isPublicApiRoute("GET", "/api/session")).toBe(true);

    expect(isPublicApiRoute("GET", "/api/quote")).toBe(false);
    expect(isPublicApiRoute("POST", "/api/chat")).toBe(false);
    expect(isPublicApiRoute("GET", "/api/new-feature")).toBe(false);
    expect(isPublicApiRoute("GET", "/")).toBe(false);
  });
});
