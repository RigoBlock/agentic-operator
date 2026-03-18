/**
 * Postinstall patch: make WDK packages work in Cloudflare Workers.
 *
 * Cloudflare Workers cannot load native C++ addons. WDK's dependency chain
 * includes sodium-native (libsodium C bindings) and bare-crypto (Bare runtime).
 * Both need to be replaced with pure-JS equivalents:
 *
 *   sodium-native    →  sodium-javascript  (pure JS libsodium)
 *   sodium-universal →  sodium-javascript  (skip the intermediary)
 *   bare-crypto      →  node:crypto        (Workers nodejs_compat)
 *
 * WDK wallet-evm uses sodium-universal → sodium-native for exactly one function:
 *   sodium_memzero() in src/memory-safe/signing-key.js (secure key disposal)
 *
 * sodium-javascript provides the same API in pure JavaScript.
 */
const fs = require('fs');
const path = require('path');

// ── Patch sodium-native → sodium-javascript ──────────────────────────
const sodiumNative = path.join(__dirname, '..', 'node_modules', 'sodium-native', 'index.js');
if (fs.existsSync(sodiumNative)) {
  fs.writeFileSync(
    sodiumNative,
    "// Patched for Cloudflare Workers: redirect to pure-JS sodium-javascript\n" +
    "module.exports = require('sodium-javascript');\n"
  );
  console.log('✓ Patched sodium-native → sodium-javascript (Workers compat)');
} else {
  console.log('⚠ sodium-native not found — skip patch');
}

// ── Patch sodium-universal → sodium-javascript ───────────────────────
// sodium-universal is CJS (module.exports = require('sodium-native'))
// but WDK does `import { sodium_memzero } from 'sodium-universal'` (ESM named import).
// Node.js can't destructure CJS as ESM named imports. Fix: re-export directly.
const sodiumUniversal = path.join(__dirname, '..', 'node_modules', 'sodium-universal', 'index.js');
if (fs.existsSync(sodiumUniversal)) {
  fs.writeFileSync(
    sodiumUniversal,
    "// Patched for Workers + Node.js ESM compat: re-export sodium-javascript directly\n" +
    "module.exports = require('sodium-javascript');\n"
  );
  console.log('✓ Patched sodium-universal → sodium-javascript (ESM interop fix)');
} else {
  console.log('⚠ sodium-universal not found — skip patch');
}

// ── Patch bare-crypto → node:crypto ──────────────────────────────────
const bareCrypto = path.join(__dirname, '..', 'node_modules', 'bare-crypto', 'index.js');
if (fs.existsSync(bareCrypto)) {
  fs.writeFileSync(
    bareCrypto,
    "// Patched for Cloudflare Workers: redirect to node:crypto (nodejs_compat)\n" +
    "module.exports = require('node:crypto');\n"
  );
  console.log('✓ Patched bare-crypto → node:crypto (Workers compat)');
} else {
  console.log('⚠ bare-crypto not found — skip patch');
}
