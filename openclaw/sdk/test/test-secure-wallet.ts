/**
 * End-to-end test for SecureWalletSession:
 *   1. Create encrypted wallet (createEncrypted)
 *   2. Save encrypted store to temp file
 *   3. Load store and unlock with passkey
 *   4. Verify address matches
 *   5. Verify wrong passkey fails
 *   6. Sign operator auth
 *   7. Dispose
 */
import { SecureWalletSession, saveEncryptedStore, loadEncryptedStore } from "../src/wallet.js";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";

const PASSKEY = "my-strong-test-passkey-2024";
const storePath = join(tmpdir(), `rigoblock-test-${Date.now()}.enc.json`);

async function main() {
  console.log("=== SecureWalletSession E2E Test ===\n");

  // 1. Create encrypted wallet
  console.log("1) Creating encrypted wallet...");
  const { session, store, seedPhraseBackup } = await SecureWalletSession.createEncrypted(PASSKEY);

  console.log("   Address:", session.address);
  console.log("   Seed (backup):", seedPhraseBackup);
  console.log("   Store salt (b64):", store.salt);
  console.log("   Store encrypted entropy length:", store.encryptedEntropy.length, "chars (b64)");
  console.log("   ✅ Created\n");

  // 2. Save to file
  console.log("2) Saving encrypted store to:", storePath);
  await saveEncryptedStore(storePath, store);
  console.log("   ✅ Saved\n");

  // 3. Load and unlock
  console.log("3) Loading store and unlocking...");
  const loadedStore = await loadEncryptedStore(storePath);
  const session2 = await SecureWalletSession.unlock(PASSKEY, loadedStore);
  console.log("   Unlocked address:", session2.address);
  console.log("   ✅ Unlocked\n");

  // 4. Verify address matches
  console.log("4) Verifying addresses match...");
  if (session.address.toLowerCase() !== session2.address.toLowerCase()) {
    throw new Error(`Address mismatch: ${session.address} vs ${session2.address}`);
  }
  console.log("   ✅ Addresses match\n");

  // 5. Wrong passkey should fail
  console.log("5) Testing wrong passkey...");
  try {
    await SecureWalletSession.unlock("wrong-passkey-1234", loadedStore);
    throw new Error("Should have thrown!");
  } catch (e: any) {
    if (e.message.includes("Decryption failed") || e.message.includes("mismatch")) {
      console.log("   ✅ Wrong passkey correctly rejected:", e.message, "\n");
    } else {
      throw e;
    }
  }

  // 6. Sign operator auth
  console.log("6) Signing operator auth...");
  const auth = await session2.signOperatorAuth();
  console.log("   Operator address:", auth.operatorAddress);
  console.log("   Signature:", auth.authSignature.slice(0, 20) + "...");
  console.log("   Timestamp:", new Date(auth.authTimestamp).toISOString());
  console.log("   ✅ Signed\n");

  // 7. Cleanup
  console.log("7) Disposing...");
  session.dispose();
  session2.dispose();
  try { unlinkSync(storePath); } catch {}
  console.log("   ✅ Disposed\n");

  console.log("=== ALL TESTS PASSED ===");
}

main().catch((e) => {
  console.error("FAILED:", e);
  try { unlinkSync(storePath); } catch {}
  process.exit(1);
});
