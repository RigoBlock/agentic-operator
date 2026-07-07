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
 * Parse the body of an outgoing JSON-RPC request and count the individual
 * RPC calls. Single requests count as 1; batched arrays count as their length.
 * Only bodies with Content-Type `application/json` are parsed.
 */
function countRpcCallsInBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): { count: number; methods: string[] } {
  const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const contentType = extractContentType(headers);
  if (!contentType?.toLowerCase().includes("application/json")) {
    return { count: 0, methods: [] };
  }

  const body = init?.body ?? (input instanceof Request ? input.body : undefined);
  if (!body) return { count: 0, methods: [] };

  try {
    const text = typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : undefined;
    if (text === undefined) return { count: 0, methods: [] };
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const methods: string[] = [];
      let count = 0;
      for (const item of parsed) {
        if (item && typeof item === "object" && typeof item.method === "string") {
          count++;
          methods.push(item.method);
        }
      }
      return { count, methods };
    }
    if (parsed && typeof parsed === "object" && typeof parsed.method === "string") {
      return { count: 1, methods: [parsed.method] };
    }
  } catch {
    // Not valid JSON — ignore.
  }
  return { count: 0, methods: [] };
}

function extractContentType(headers?: HeadersInit | Headers): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return headers.get("content-type") ?? undefined;
  }
  if (Array.isArray(headers)) {
    const entry = headers.find(([k]) => k.toLowerCase() === "content-type");
    return entry?.[1];
  }
  return (headers as Record<string, string>)["content-type"] ?? (headers as Record<string, string>)["Content-Type"];
}

/**
 * Wrap a fetch function so it increments the current request's HTTP RPC counter
 * and counts individual JSON-RPC calls in the outgoing body.
 * Safe to use even when no metrics context is active.
 */
export function wrapFetchWithMetrics(
  fetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const metrics = getRpcMetrics();
    if (metrics) {
      metrics.incrementHttpRequest();
      const { count, methods } = countRpcCallsInBody(input, init as RequestInit | undefined);
      if (count > 0) {
        for (const method of methods) {
          metrics.incrementRpcCall(method);
        }
      }
    }
    return fetch(input, init);
  };
}
