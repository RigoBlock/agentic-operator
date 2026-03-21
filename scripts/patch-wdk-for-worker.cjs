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
// Also add extension_pbkdf2_sha512_async polyfill for wdk-secret-manager's
// bip39-mnemonic dependency (which uses a sodium-native-only extension).
const sodiumUniversal = path.join(__dirname, '..', 'node_modules', 'sodium-universal', 'index.js');
if (fs.existsSync(sodiumUniversal)) {
  fs.writeFileSync(
    sodiumUniversal,
    "// Patched for Workers + Node.js ESM compat: re-export sodium-javascript directly\n" +
    "const sodium = require('sodium-javascript');\n" +
    "// Polyfill: sodium-native extension_pbkdf2_sha512_async (used by bip39-mnemonic)\n" +
    "// Falls back to node:crypto pbkdf2 which Workers support via nodejs_compat.\n" +
    "// Lazy require to avoid breaking browser bundles (which don't call this function).\n" +
    "if (!sodium.extension_pbkdf2_sha512_async) {\n" +
    "  sodium.extension_pbkdf2_sha512_async = function (output, password, salt, iterations, keyLength) {\n" +
    "    var pbkdf2 = require('node:crypto').pbkdf2;\n" +
    "    return new Promise(function (resolve, reject) {\n" +
    "      pbkdf2(password, salt, iterations, keyLength, 'sha512', function (err, derived) {\n" +
    "        if (err) return reject(err);\n" +
    "        output.set(derived);\n" +
    "        resolve();\n" +
    "      });\n" +
    "    });\n" +
    "  };\n" +
    "}\n" +
    "module.exports = sodium;\n"
  );
  console.log('✓ Patched sodium-universal → sodium-javascript + pbkdf2 polyfill');
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

// ── Patch sha512-universal → pure JS (skip sha512-wasm WebAssembly) ──
// sha512-universal unconditionally require('sha512-wasm') which calls
// new WebAssembly.Module() at load time — blocked by Cloudflare Workers.
// It has a built-in pure JS fallback (sha512.js) so we just use that.
const sha512Universal = path.join(__dirname, '..', 'node_modules', 'sha512-universal', 'index.js');
if (fs.existsSync(sha512Universal)) {
  fs.writeFileSync(
    sha512Universal,
    "// Patched for Cloudflare Workers: use pure JS (skip WASM)\n" +
    "const Sha512 = require('./sha512.js');\n" +
    "module.exports = function () { return new Sha512(); };\n" +
    "module.exports.ready = function (cb) { if (cb) cb(); };\n" +
    "module.exports.WASM_SUPPORTED = false;\n" +
    "module.exports.WASM_LOADED = false;\n" +
    "module.exports.SHA512_BYTES = 64;\n"
  );
  console.log('✓ Patched sha512-universal → pure JS (skip WASM)');
} else {
  console.log('⚠ sha512-universal not found — skip patch');
}

// ── Patch sha256-universal → pure JS (skip sha256-wasm WebAssembly) ──
const sha256Universal = path.join(__dirname, '..', 'node_modules', 'sha256-universal', 'index.js');
if (fs.existsSync(sha256Universal)) {
  fs.writeFileSync(
    sha256Universal,
    "// Patched for Cloudflare Workers: use pure JS (skip WASM)\n" +
    "const Sha256 = require('./sha256.js');\n" +
    "module.exports = function () { return new Sha256(); };\n" +
    "module.exports.ready = function (cb) { if (cb) cb(); };\n" +
    "module.exports.WASM_SUPPORTED = false;\n" +
    "module.exports.WASM_LOADED = false;\n" +
    "module.exports.SHA256_BYTES = 32;\n"
  );
  console.log('✓ Patched sha256-universal → pure JS (skip WASM)');
} else {
  console.log('⚠ sha256-universal not found — skip patch');
}

// ── Patch xsalsa20 → stub WASM loader (force pure JS fallback) ───────
// xsalsa20/xsalsa20.js contains embedded WASM binary + new WebAssembly.Module()
// at load time. esbuild bundles it even when guarded by `typeof WebAssembly`.
// Replace the WASM loader with a stub that returns false → triggers JS fallback.
const xsalsa20Wasm = path.join(__dirname, '..', 'node_modules', 'xsalsa20', 'xsalsa20.js');
if (fs.existsSync(xsalsa20Wasm)) {
  fs.writeFileSync(
    xsalsa20Wasm,
    "// Patched for Cloudflare Workers: stub — forces pure JS fallback in index.js\n" +
    "module.exports = function () { return false; };\n"
  );
  console.log('✓ Patched xsalsa20/xsalsa20.js → stub (forces JS fallback)');
} else {
  console.log('⚠ xsalsa20/xsalsa20.js not found — skip patch');
}

// ── Patch siphash24 → stub WASM loader (force pure JS fallback) ─────
const siphash24Wasm = path.join(__dirname, '..', 'node_modules', 'siphash24', 'siphash24.js');
if (fs.existsSync(siphash24Wasm)) {
  fs.writeFileSync(
    siphash24Wasm,
    "// Patched for Cloudflare Workers: stub — forces pure JS fallback in index.js\n" +
    "module.exports = function () { return false; };\n"
  );
  console.log('✓ Patched siphash24/siphash24.js → stub (forces JS fallback)');
} else {
  console.log('⚠ siphash24/siphash24.js not found — skip patch');
}
