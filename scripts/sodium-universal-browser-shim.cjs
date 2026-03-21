// Browser / Cloudflare-Worker polyfill for sodium-universal.
// Replaces the node:crypto-based extension_pbkdf2_sha512_async with
// the Web Crypto API (crypto.subtle), which is available in all modern
// browsers and in Cloudflare Workers without nodejs_compat.
//
// Used as an esbuild alias:
//   --alias:sodium-universal=scripts/sodium-universal-browser-shim.cjs
// so that the browser bundle of wdk-secret-manager never touches node:crypto.
'use strict';

const sodium = require('sodium-javascript');

if (!sodium.extension_pbkdf2_sha512_async) {
  sodium.extension_pbkdf2_sha512_async = async function (output, password, salt, iterations, keyLength) {
    const pwBuffer = ArrayBuffer.isView(password) ? password : Buffer.from(password);
    const saltBuffer = ArrayBuffer.isView(salt) ? salt : Buffer.from(salt);
    const keyMaterial = await globalThis.crypto.subtle.importKey(
      'raw', pwBuffer, 'PBKDF2', false, ['deriveBits']
    );
    const derived = await globalThis.crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: saltBuffer, iterations, hash: 'SHA-512' },
      keyMaterial,
      keyLength * 8
    );
    output.set(new Uint8Array(derived));
  };
}

module.exports = sodium;
