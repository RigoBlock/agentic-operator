/**
 * RPC request metrics.
 *
 * Tracks HTTP RPC requests made during a single Worker invocation so we can
 * measure optimization progress and surface per-request cost in response headers.
 *
 * Uses AsyncLocalStorage so the counter is automatically scoped to the current
 * request without passing it through every helper.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RpcMetricsSnapshot {
  /** Number of HTTP RPC requests issued. */
  httpRequests: number;
  /** Estimated individual RPC method calls (when transport-level batching is disabled this equals httpRequests). */
  rpcCalls: number;
  /** Breakdown by JSON-RPC method. */
  byMethod: Record<string, number>;
}

export class RpcMetrics {
  httpRequests = 0;
  rpcCalls = 0;
  byMethod: Record<string, number> = {};

  incrementHttpRequest(): void {
    this.httpRequests++;
  }

  incrementRpcCall(method: string): void {
    this.rpcCalls++;
    this.byMethod[method] = (this.byMethod[method] ?? 0) + 1;
  }

  snapshot(): RpcMetricsSnapshot {
    return {
      httpRequests: this.httpRequests,
      rpcCalls: this.rpcCalls,
      byMethod: { ...this.byMethod },
    };
  }
}

const rpcMetricsStore = new AsyncLocalStorage<RpcMetrics>();

/**
 * Run `fn` inside a new RPC-metrics context. All HTTP RPC requests made inside
 * this context will be counted together.
 */
export function withRpcMetrics<T>(fn: () => Promise<T>): Promise<T> {
  return rpcMetricsStore.run(new RpcMetrics(), fn);
}

/** Get the RPC-metrics context for the current async scope, if any. */
export function getRpcMetrics(): RpcMetrics | undefined {
  return rpcMetricsStore.getStore();
}

/**
 * Wrap a fetch function so it increments the current request's HTTP RPC counter.
 * Safe to use even when no metrics context is active.
 */
export function wrapFetchWithMetrics(
  fetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const metrics = getRpcMetrics();
    if (metrics) {
      metrics.incrementHttpRequest();
    }
    return fetch(input, init);
  };
}
