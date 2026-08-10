/**
 * Request-scoped access to Cloudflare Worker bindings.
 *
 * Cloudflare Workers pass secrets/bindings via the `env` argument to the fetch
 * handler, not via `process.env`. Storing the active env in AsyncLocalStorage
 * lets `getRpcUrl` and other services read it without threading `env` through
 * every helper call.
 *
 * This mirrors the existing `rpcMetrics.ts` pattern.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "../types.js";

const envStore = new AsyncLocalStorage<Env>();

/** Run `fn` with `env` as the active Worker environment for this async scope. */
export function withEnv<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  return envStore.run(env, fn);
}

/** Get the active Worker environment for the current async scope, if any. */
export function getEnv(): Env | undefined {
  return envStore.getStore();
}
