/**
 * GMX positions integration test.
 *
 * Hits the live Arbitrum RPC and the GMX SDK to verify we can read open
 * positions for a real vault. Skipped when ALCHEMY_API_KEY is not configured.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, existsSync } from "fs";
import { getGmxPositions, getGmxPositionsSummary } from "../src/services/gmxPositions.js";

function loadDevVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  if (existsSync(".dev.vars")) {
    const content = readFileSync(".dev.vars", "utf-8");
    for (const line of content.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
  }
  return vars;
}

const devVars = loadDevVars();
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || devVars.ALCHEMY_API_KEY;

// A known Rigoblock vault on Arbitrum with an open GMX perp position.
const VAULT = "0xEfa4bDf566aE50537A507863612638680420645C";

describe.skipIf(!ALCHEMY_API_KEY)("GMX positions — live Arbitrum", () => {
  beforeEach(() => {
    // No-op; kept for clarity.
  });

  it(
    "reads at least one open position for the vault",
    async () => {
      const positions = await getGmxPositions(VAULT, ALCHEMY_API_KEY);
      expect(positions.length).toBeGreaterThan(0);

      const summary = await getGmxPositionsSummary(VAULT, ALCHEMY_API_KEY);
      expect(summary.positions.length).toBeGreaterThan(0);
      expect(summary.totalSizeUsd).toMatch(/^\$[0-9,.]+[KMB]?$/);
    },
    60_000,
  );
});
