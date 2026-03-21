/**
 * Browser shim for bare-crypto.
 * pbkdf2Sync is never called when WdkSecretManager receives a pre-derived key
 * (derivedKey parameter). We derive the key via Web Crypto API before calling
 * WdkSecretManager, so this shim only exists to satisfy the import requirement.
 */
exports.pbkdf2Sync = function () {
  throw new Error('bare-crypto.pbkdf2Sync: pass derivedKey directly in browser');
};
exports.pbkdf2 = function () {
  throw new Error('bare-crypto.pbkdf2: pass derivedKey directly in browser');
};
