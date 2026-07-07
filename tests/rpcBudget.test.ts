/**
 * RPC budget / metrics tests.
 *
 * Verifies that outgoing JSON-RPC requests are counted correctly so per-path
 * RPC usage can be observed and optimized.
 */
import { describe, it, expect, vi } from "vitest";
import {
  withRpcMetrics,
  wrapFetchWithMetrics,
  getRpcMetrics,
} from "../src/services/rpcMetrics.js";

describe("RPC budget", () => {
  function makeFetch() {
    return vi.fn(
      async () =>
        new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  }

  it("counts a single JSON-RPC call", async () => {
    const fetch = makeFetch();
    const wrapped = wrapFetchWithMetrics(fetch);

    await withRpcMetrics(async () => {
      await wrapped("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [], id: 1 }),
      });

      const metrics = getRpcMetrics()!;
      expect(metrics.httpRequests).toBe(1);
      expect(metrics.rpcCalls).toBe(1);
      expect(metrics.byMethod.eth_call).toBe(1);
    });
  });

  it("counts batched JSON-RPC calls by array length", async () => {
    const fetch = makeFetch();
    const wrapped = wrapFetchWithMetrics(fetch);

    await withRpcMetrics(async () => {
      await wrapped("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", method: "eth_call", params: [], id: 1 },
          { jsonrpc: "2.0", method: "eth_estimateGas", params: [], id: 2 },
          { jsonrpc: "2.0", method: "eth_call", params: [], id: 3 },
        ]),
      });

      const metrics = getRpcMetrics()!;
      expect(metrics.httpRequests).toBe(1);
      expect(metrics.rpcCalls).toBe(3);
      expect(metrics.byMethod.eth_call).toBe(2);
      expect(metrics.byMethod.eth_estimateGas).toBe(1);
    });
  });

  it("does not count non-JSON bodies", async () => {
    const fetch = makeFetch();
    const wrapped = wrapFetchWithMetrics(fetch);

    await withRpcMetrics(async () => {
      await wrapped("http://localhost", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "not json",
      });

      const metrics = getRpcMetrics()!;
      expect(metrics.httpRequests).toBe(1);
      expect(metrics.rpcCalls).toBe(0);
    });
  });
});
