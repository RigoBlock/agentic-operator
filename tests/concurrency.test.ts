/**
 * Concurrency limiter tests.
 */
import { describe, it, expect } from "vitest";
import { mapWithConcurrency, mapWithConcurrencySettled } from "../src/services/concurrency.js";

describe("mapWithConcurrency", () => {
  it("preserves result order", async () => {
    const result = await mapWithConcurrency(
      [3, 1, 2],
      async (n) => n * 2,
      2,
    );
    expect(result).toEqual([6, 2, 4]);
  });

  it("limits parallel execution", async () => {
    let running = 0;
    let maxRunning = 0;
    await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
      },
      2,
    );
    expect(maxRunning).toBe(2);
  });

  it("rejects if any item rejects", async () => {
    await expect(
      mapWithConcurrency(
        [1, 2, 3],
        async (n) => {
          if (n === 2) throw new Error("boom");
          return n;
        },
        2,
      ),
    ).rejects.toThrow("boom");
  });
});

describe("mapWithConcurrencySettled", () => {
  it("returns fulfilled and rejected results in order", async () => {
    const results = await mapWithConcurrencySettled(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error("boom");
        return n * 2;
      },
      2,
    );

    expect(results[0]).toEqual({ status: "fulfilled", value: 2 });
    expect(results[1]).toEqual({ status: "rejected", reason: new Error("boom") });
    expect(results[2]).toEqual({ status: "fulfilled", value: 6 });
  });
});
