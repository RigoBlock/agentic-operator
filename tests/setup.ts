/**
 * Vitest setup — injects a dummy Alchemy API key so unit tests that exercise
 * on-chain helpers via `getRpcUrl()` / `getRpcProvider()` do not throw at
 * import/call time. Integration tests that need a live key should set it in the
 * environment (or `.dev.vars`) before running; that real value takes precedence.
 */
if (!process.env.ALCHEMY_API_KEY) {
  process.env.ALCHEMY_API_KEY = "test-key";
}
