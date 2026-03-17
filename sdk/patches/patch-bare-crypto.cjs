/**
 * Postinstall patch: make bare-crypto work in Node.js.
 *
 * @tetherto/wdk-secret-manager depends on bare-crypto, which requires
 * the Bare runtime's `require.addon()`. In Node.js this crashes.
 *
 * Since wdk-secret-manager only uses `bareCrypto.pbkdf2Sync()`, and
 * Node's `crypto.pbkdf2Sync` has the same signature, we replace
 * bare-crypto's entry point with a one-line redirect to node:crypto.
 *
 * See: https://docs.wdk.tether.io/tools/secret-manager/configuration
 * "Runtime Notes → Node.js: Uses sodium-native and Node crypto (PBKDF2)."
 */
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'node_modules', 'bare-crypto', 'index.js');

if (fs.existsSync(target)) {
  fs.writeFileSync(target, "// Patched for Node.js: redirect to node:crypto\nmodule.exports = require('node:crypto');\n");
  console.log('✓ Patched bare-crypto for Node.js compatibility');
} else {
  console.log('⚠ bare-crypto not found — skip patch (not needed if running in Bare runtime)');
}
