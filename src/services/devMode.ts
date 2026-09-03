/**
 * Development-mode gating for security escape hatches.
 *
 * The repo supports two local-dev escape hatches that weaken production
 * security invariants:
 *   - TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK — skip Telegram webhook secret
 *     verification (unverified updates can impersonate paired users).
 *   - X402_RELAXED — serve paid endpoints when payment cannot be verified.
 *
 * These MUST never be active in a deployed environment. They activate only
 * when the deployment is explicitly marked APP_ENV=development — a variable
 * that exists solely in the local, gitignored .dev.vars and must never be
 * configured on the Cloudflare dashboard. A hatch variable set anywhere
 * without APP_ENV=development is ignored (fail closed) and turns the
 * deployment into a loud outage via validateEnvironmentConfig, so a secret
 * pasted into the wrong dashboard can never silently disable authentication
 * or payment verification.
 */

import type { Env } from "../types.js";
import { getEnv } from "./envContext.js";

export const DEV_ESCAPE_HATCHES = [
  "TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK",
  "X402_RELAXED",
] as const;

export type DevEscapeHatch = (typeof DEV_ESCAPE_HATCHES)[number];

/** True only when the deployment is explicitly marked as local development. */
export function isDevelopment(env?: Env): boolean {
  return (env ?? getEnv())?.APP_ENV === "development";
}

/**
 * Decide whether a dev escape hatch is active.
 *
 * Strict conjunction: the flag must be "1" AND APP_ENV must be exactly
 * "development". Any other APP_ENV value (including unset) disables the
 * hatch and logs a critical error pointing at the misconfiguration.
 */
export function isDevEscapeHatchEnabled(
  flag: DevEscapeHatch,
  env?: Env,
): boolean {
  const e = env ?? getEnv();
  if (!e || e[flag] !== "1") return false;
  if (e.APP_ENV === "development") return true;
  console.error(
    `[security] ${flag}=1 is set but APP_ENV is not "development" — ` +
      `the escape hatch is DISABLED. Remove ${flag} from this deployment's ` +
      `secrets: it has no effect here and must never accompany a production config.`,
  );
  return false;
}

/**
 * Fail-closed deployment validation, run at the top of every request.
 *
 * Returns an error message when the configuration is inconsistent — i.e. a
 * hatch flag is set without APP_ENV=development — so the misconfiguration
 * becomes an immediate, unmissable 500 instead of a dormant landmine.
 * Returns null when the configuration is consistent.
 */
export function validateEnvironmentConfig(env: Env): string | null {
  if (env.APP_ENV === "development") {
    const active = DEV_ESCAPE_HATCHES.filter((f) => env[f] === "1");
    if (active.length > 0) {
      console.warn(
        `[security] APP_ENV=development — dev escape hatches active: ${active.join(", ")}. ` +
          `This deployment must never be exposed publicly.`,
      );
    }
    return null;
  }
  const rogue = DEV_ESCAPE_HATCHES.filter((f) => env[f] === "1");
  if (rogue.length > 0) {
    return (
      `Invalid deployment configuration: ${rogue.join(", ")} ` +
      `require APP_ENV=development and have no effect here. ` +
      `Remove them from this deployment's secrets/vars immediately.`
    );
  }
  return null;
}
