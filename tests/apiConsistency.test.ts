/**
 * API Consistency Tests
 *
 * These tests enforce that routes, middleware, docs, and discovery endpoints
 * stay in sync. When a new /api/* route is added, these tests will fail unless
 * the route is properly registered in:
 *   - PROTECTED_ROUTES or PUBLIC_API_ROUTES (x402 middleware)
 *   - public/openapi.json
 *   - Health check paidRoutes
 *   - /api discovery endpoint
 *   - /.well-known/x402.json
 *   - /.well-known/api-catalog
 *
 * This prevents the "add a route, forget the docs" problem.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { app } from "../src/index.js";
import { PROTECTED_ROUTES, PUBLIC_API_ROUTES, isPublicApiRoute } from "../src/middleware/x402.js";

const SRC_DIR = join(__dirname, "../src");
const PUBLIC_DIR = join(__dirname, "../public");

function mockEnv(): Record<string, string> {
  return {
    UNISWAP_API_KEY: "test",
    ZEROX_API_KEY: "test",
    ALCHEMY_API_KEY: "test",
    // Empty CDP creds so x402 middleware skips initialization in tests
    // (avoids noisy facilitator error logs).
    CDP_API_KEY_ID: "",
    CDP_API_KEY_SECRET: "",
  };
}

// ── Route Discovery from src/index.ts ───────────────────────────────────

interface DiscoveredRoute {
  method: string;
  path: string;
}

function discoverRoutes(): DiscoveredRoute[] {
  const indexSrc = readFileSync(join(SRC_DIR, "index.ts"), "utf-8");
  const routes: DiscoveredRoute[] = [];

  // 1. Inline handlers: app.get("/api/...", ...) or app.post("/api/...", ...)
  const inlineRe = /app\.(get|post|put|delete)\("(\/api\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(indexSrc)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2] });
  }

  // 2. Sub-routers: app.route("/api/...", quoteUniswap)
  const subRouterRe = /app\.route\("(\/api\/[^"]+)",\s*(\w+)\)/g;

  // Build import map: variableName -> module path (relative to src/)
  const imports = new Map<string, string>();
  const importRe = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
  while ((m = importRe.exec(indexSrc)) !== null) {
    const names = m[1].split(",").map((s) => {
      const parts = s.trim().split(/\s+as\s+/);
      return parts[parts.length - 1].trim();
    });
    const modulePath = m[2]; // e.g. "./routes/quoteUniswap.js"
    for (const name of names) {
      if (name) imports.set(name, modulePath);
    }
  }

  while ((m = subRouterRe.exec(indexSrc)) !== null) {
    const path = m[1];
    const varName = m[2];
    const modulePath = imports.get(varName);
    if (!modulePath) {
      throw new Error(`Could not resolve import for sub-router "${varName}" used at ${path}`);
    }

    // Resolve "./routes/quoteUniswap.js" -> "src/routes/quoteUniswap.ts"
    const relative = modulePath.replace(/^\.\//, "").replace(/\.js$/, ".ts");
    const resolvedPath = join(SRC_DIR, relative);
    const routeSrc = readFileSync(resolvedPath, "utf-8");

    // Find the router variable name declared inside the sub-router file
    // (e.g. "const tools = new Hono<...>()" → "tools"). The import alias in
    // index.ts (e.g. "toolsRoute") does NOT match the variable used inside the file.
    const routerVarMatch = routeSrc.match(/const\s+(\w+)\s*=\s*new\s+Hono/);
    const routerVar = routerVarMatch ? routerVarMatch[1] : varName;

    // Find methods: tools.get("/", ...) or oracle.post("/refresh", ...)
    const methodRe = new RegExp(`${routerVar}\\.(get|post|put|delete)\\("([^"]+)"`, "g");
    let mm: RegExpExecArray | null;
    while ((mm = methodRe.exec(routeSrc)) !== null) {
      const subPath = mm[2];
      const fullPath = subPath === "/" ? path : `${path}${subPath}`;
      routes.push({ method: mm[1].toUpperCase(), path: fullPath });
    }
  }

  return routes;
}

// ── OpenAPI helpers ─────────────────────────────────────────────────────

function loadOpenApi(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PUBLIC_DIR, "openapi.json"), "utf-8")) as Record<string, unknown>;
}

function openApiHasPathMethod(openapi: Record<string, unknown>, path: string, method: string): boolean {
  const paths = openapi.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return false;
  const pathEntry = paths[path];
  if (!pathEntry) return false;
  return method.toLowerCase() in pathEntry;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("API Consistency", () => {
  const discoveredRoutes = discoverRoutes();
  const protectedKeys = Object.keys(PROTECTED_ROUTES);
  const openapi = loadOpenApi();

  // ── 1. Route coverage ──

  it("every discovered /api/ route is covered by PUBLIC_API_ROUTES or PROTECTED_ROUTES", () => {
    const uncovered: string[] = [];
    for (const route of discoveredRoutes) {
      const key = `${route.method} ${route.path}`;
      const covered = isPublicApiRoute(route.method, route.path) || protectedKeys.includes(key);
      if (!covered) {
        uncovered.push(key);
      }
    }
    expect(uncovered).toEqual([]);
  });

  it("no duplicate routes are discovered", () => {
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const route of discoveredRoutes) {
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) dups.push(key);
      seen.add(key);
    }
    expect(dups).toEqual([]);
  });

  // ── 2. OpenAPI coverage ──

  it("every PROTECTED_ROUTES key has a matching OpenAPI path+method", () => {
    const missing: string[] = [];
    for (const key of protectedKeys) {
      const [method, ...pathParts] = key.split(" ");
      const path = pathParts.join(" ");
      if (!openApiHasPathMethod(openapi, path, method)) {
        missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every discovered /api/ route has a matching OpenAPI path+method", () => {
    const missing: string[] = [];
    for (const route of discoveredRoutes) {
      if (!openApiHasPathMethod(openapi, route.path, route.method)) {
        missing.push(`${route.method} ${route.path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // ── 3. Discovery endpoint sync (runtime requests) ──

  it("health check paidRoutes lists all PROTECTED_ROUTES keys and no extras", async () => {
    const res = await app.request("/api/health", {}, mockEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { x402: { paidRoutes: Record<string, string> } };
    const paidRoutes = json.x402.paidRoutes;
    const missing = protectedKeys.filter((k) => !(k in paidRoutes));
    const extra = Object.keys(paidRoutes).filter((k) => !protectedKeys.includes(k));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("/api discovery endpoint lists all PROTECTED_ROUTES keys and no extras", async () => {
    const res = await app.request("/api", {}, mockEnv());
    expect(res.status).toBe(402);
    const json = (await res.json()) as { endpoints: Record<string, { price: string; description: string }> };
    const endpoints = json.endpoints;
    const missing = protectedKeys.filter((k) => !(k in endpoints));
    const extra = Object.keys(endpoints).filter((k) => !protectedKeys.includes(k));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("/.well-known/x402.json lists all PROTECTED_ROUTES keys and no extras", async () => {
    const res = await app.request("/.well-known/x402.json", {}, mockEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { endpoints: Array<{ path: string; method: string }> };
    const x402Keys = json.endpoints.map((e) => `${e.method.toUpperCase()} ${e.path}`);
    const missing = protectedKeys.filter((k) => !x402Keys.includes(k));
    const extra = x402Keys.filter((k) => !protectedKeys.includes(k));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("/.well-known/api-catalog has anchors for all PROTECTED_ROUTES paths", async () => {
    const res = await app.request("/.well-known/api-catalog", {}, mockEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { linkset: Array<{ anchor: string }> };
    const anchors = json.linkset.map((e) => e.anchor);
    const protectedPaths = protectedKeys
      .map((k) => k.split(" ").slice(1).join(" "))
      .filter((p, i, arr) => arr.indexOf(p) === i);
    const missing = protectedPaths.filter((path) => !anchors.some((a) => a.endsWith(path)));
    expect(missing).toEqual([]);
  });

  // ── 4. General hygiene ──

  it("openapi.json is valid JSON", () => {
    expect(() => JSON.parse(readFileSync(join(PUBLIC_DIR, "openapi.json"), "utf-8"))).not.toThrow();
  });

  it("no stale requirePriceFeed references outside swapShield", () => {
    const srcFiles = [
      "src/routes/quoteUniswap.ts",
      "src/routes/quote0x.ts",
      "src/routes/quote.ts",
      "src/routes/chat.ts",
      "src/routes/tools.ts",
      "src/routes/oracle.ts",
      "src/index.ts",
      "public/openapi.json",
    ];
    const offenders: string[] = [];
    for (const relPath of srcFiles) {
      const content = readFileSync(join(__dirname, "..", relPath), "utf-8");
      if (content.includes("requirePriceFeed")) {
        offenders.push(relPath);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("AGENTS.md does not mention removed features (requirePriceFeed, 422 oracle)", () => {
    const content = readFileSync(join(__dirname, "../AGENTS.md"), "utf-8");
    expect(content).not.toContain("requirePriceFeed");
    expect(content).not.toMatch(/422.*oracle|oracle.*422/i);
  });
});
