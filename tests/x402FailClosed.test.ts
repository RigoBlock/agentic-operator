/**
 * x402 Fail-Closed Safety Tests
 *
 * Ensures that /api/* routes not explicitly listed in PROTECTED_ROUTES
 * or PUBLIC_API_ROUTES are blocked with 503, rather than silently passing
 * through (which would confuse agents with 401 from the route's own auth).
 *
 * Safety invariant (enforced by src/middleware/x402.ts):
 *   IF processHTTPRequest returns "no-payment-required"
 *   AND the route is /api/* but NOT in PUBLIC_API_ROUTES and NOT in PROTECTED_ROUTES
 *   THEN return 503.
 *
 * Routes that ARE in PROTECTED_ROUTES may legitimately return "no-payment-required"
 * when onProtectedRequest grants access (e.g. frontend session token or exempt origin).
 * These must NOT be blocked.
 *
 * The full integration test would require mocking the @x402/core SDK,
 * which is brittle. The critical logic is covered by:
 *   1. isPublicApiRoute() and isProtectedRoute() unit tests (below)
 *   2. apiConsistency.test.ts — validates every discovered route is in
 *      PUBLIC_API_ROUTES or PROTECTED_ROUTES
 */
import { describe, it, expect } from "vitest";

describe("x402 middleware fail-closed logic", () => {
  it("isPublicApiRoute returns true only for explicitly public routes", async () => {
    const { isPublicApiRoute } = await import("../src/middleware/x402.js");

    expect(isPublicApiRoute("GET", "/api/health")).toBe(true);
    expect(isPublicApiRoute("GET", "/api/chains")).toBe(true);

    expect(isPublicApiRoute("GET", "/api/quote")).toBe(false);
    expect(isPublicApiRoute("POST", "/api/chat")).toBe(false);
    expect(isPublicApiRoute("GET", "/api/new-feature")).toBe(false);
    expect(isPublicApiRoute("GET", "/")).toBe(false);
  });

  it("isProtectedRoute returns true only for explicitly protected routes", async () => {
    const { isProtectedRoute } = await import("../src/middleware/x402.js");

    expect(isProtectedRoute("POST", "/api/chat")).toBe(true);
    expect(isProtectedRoute("GET", "/api/quote")).toBe(true);

    expect(isProtectedRoute("GET", "/api/health")).toBe(false);
    expect(isProtectedRoute("GET", "/api/new-feature")).toBe(false);
    expect(isProtectedRoute("GET", "/")).toBe(false);
  });
});
