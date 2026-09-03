/**
 * Dev-mode gating tests (escape hatches).
 *
 * TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK and X402_RELAXED weaken production
 * security invariants. They must activate ONLY when APP_ENV is exactly
 * "development" — a stray flag in production secrets must be inert (and is
 * additionally surfaced as a hard startup error by validateEnvironmentConfig).
 */
import { describe, it, expect } from "vitest";
import {
  isDevelopment,
  isDevEscapeHatchEnabled,
  validateEnvironmentConfig,
  DEV_ESCAPE_HATCHES,
} from "../src/services/devMode.js";
import type { Env } from "../src/types.js";

const base = {} as Env;

describe("isDevelopment", () => {
  it("is true only for the exact string 'development'", () => {
    expect(isDevelopment({ ...base, APP_ENV: "development" })).toBe(true);
    expect(isDevelopment(base)).toBe(false);
    expect(isDevelopment({ ...base, APP_ENV: "production" })).toBe(false);
    expect(isDevelopment({ ...base, APP_ENV: "Development" })).toBe(false);
    expect(isDevelopment({ ...base, APP_ENV: "dev" })).toBe(false);
  });
});

describe("isDevEscapeHatchEnabled", () => {
  it("activates only with flag=1 AND APP_ENV=development", () => {
    const env = { ...base, APP_ENV: "development", X402_RELAXED: "1" } as Env;
    expect(isDevEscapeHatchEnabled("X402_RELAXED", env)).toBe(true);
  });

  it("is inert when the flag is set without APP_ENV=development", () => {
    expect(isDevEscapeHatchEnabled("X402_RELAXED", { ...base, X402_RELAXED: "1" })).toBe(false);
    expect(
      isDevEscapeHatchEnabled("X402_RELAXED", { ...base, APP_ENV: "production", X402_RELAXED: "1" }),
    ).toBe(false);
    // Near-miss values must not activate the hatch
    expect(
      isDevEscapeHatchEnabled("X402_RELAXED", { ...base, APP_ENV: "Development", X402_RELAXED: "1" }),
    ).toBe(false);
    expect(
      isDevEscapeHatchEnabled("X402_RELAXED", { ...base, APP_ENV: "dev", X402_RELAXED: "1" }),
    ).toBe(false);
  });

  it("is inert when the flag has any value other than '1'", () => {
    const env = { ...base, APP_ENV: "development", X402_RELAXED: "true" } as Env;
    expect(isDevEscapeHatchEnabled("X402_RELAXED", env)).toBe(false);
  });

  it("covers both hatch flags", () => {
    expect(DEV_ESCAPE_HATCHES).toEqual([
      "TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK",
      "X402_RELAXED",
    ]);
    const env = {
      ...base,
      APP_ENV: "development",
      TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK: "1",
    } as Env;
    expect(isDevEscapeHatchEnabled("TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK", env)).toBe(true);
  });
});

describe("validateEnvironmentConfig", () => {
  it("passes a clean production config (no APP_ENV, no hatches)", () => {
    expect(validateEnvironmentConfig(base)).toBeNull();
    expect(validateEnvironmentConfig({ ...base, APP_ENV: "production" })).toBeNull();
  });

  it("fails closed when a hatch flag is set without APP_ENV=development", () => {
    const err = validateEnvironmentConfig({ ...base, X402_RELAXED: "1" });
    expect(err).toContain("X402_RELAXED");
    const err2 = validateEnvironmentConfig({
      ...base,
      TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK: "1",
    });
    expect(err2).toContain("TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK");
  });

  it("passes when hatches are set together with APP_ENV=development", () => {
    expect(
      validateEnvironmentConfig({
        ...base,
        APP_ENV: "development",
        X402_RELAXED: "1",
        TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK: "1",
      }),
    ).toBeNull();
  });

  it("lists every rogue hatch in the error", () => {
    const err = validateEnvironmentConfig({
      ...base,
      X402_RELAXED: "1",
      TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK: "1",
    });
    expect(err).toContain("X402_RELAXED");
    expect(err).toContain("TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK");
  });
});
