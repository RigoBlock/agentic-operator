/**
 * Request-scoped concurrency limiter.
 *
 * Cloudflare Workers / Alchemy handle total throughput well, but many parallel
 * RPC calls create peak compute-unit spikes. Capping fan-outs (multi-chain
 * discovery, aggregated NAV, etc.) to a small pool keeps peak load bounded
 * without serializing everything.
 */

/** Default concurrency for multi-chain RPC fan-outs. */
export const DEFAULT_RPC_CONCURRENCY = 3;

async function runPool<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
  settled: boolean,
): Promise<R[] | PromiseSettledResult<R>[]> {
  if (concurrency <= 0) throw new Error("concurrency must be positive");
  if (items.length === 0) return [];

  const results = new Array<R | PromiseSettledResult<R>>(items.length);
  const pool = Math.min(concurrency, items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: pool }, async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= items.length) break;
        if (settled) {
          try {
            results[idx] = { status: "fulfilled", value: await fn(items[idx], idx) };
          } catch (reason) {
            results[idx] = { status: "rejected", reason };
          }
        } else {
          results[idx] = await fn(items[idx], idx);
        }
      }
    }),
  );

  return results as R[] | PromiseSettledResult<R>[];
}

/**
 * Map over `items` with at most `concurrency` parallel invocations of `fn`.
 * Preserves result order. If any `fn` rejects, the whole map rejects.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number = DEFAULT_RPC_CONCURRENCY,
): Promise<R[]> {
  return runPool(items, fn, concurrency, false) as Promise<R[]>;
}

/**
 * Map over `items` with at most `concurrency` parallel invocations of `fn`,
 * returning a `PromiseSettledResult` for each item (like `Promise.allSettled`).
 * Preserves result order and never rejects.
 */
export async function mapWithConcurrencySettled<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number = DEFAULT_RPC_CONCURRENCY,
): Promise<PromiseSettledResult<R>[]> {
  return runPool(items, fn, concurrency, true) as Promise<PromiseSettledResult<R>[]>;
}
