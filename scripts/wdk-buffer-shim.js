/**
 * Buffer polyfill for WDK browser bundle.
 * WDK's bip39 dependency uses Node.js Buffer for mnemonic/seed operations.
 * The 'buffer' npm package provides a browser-compatible implementation.
 * esbuild resolves this to node_modules/buffer (already in the dependency tree).
 */
import { Buffer } from 'buffer';
globalThis.Buffer = globalThis.Buffer || Buffer;
