/**
 * WDK Wallet integration for the Rigoblock OpenClaw skill.
 *
 * Uses Tether's WDK (`@tetherto/wdk-wallet-evm`) for self-custodial
 * wallet creation, signing, and account management. The WDK wallet:
 *
 *   1. Creates wallets in-app (no env variable required)
 *   2. Signs x402 USDT0 payments on Plasma/Stable
 *   3. Signs operator auth messages for delegated execution
 *   4. Satisfies the x402 ClientEvmSigner interface directly
 *
 * Architecture:
 *   - WDK manages the OPERATOR wallet (user's wallet — vault owner)
 *   - WDK manages the x402 PAYMENT wallet (pays for API calls)
 *   - WDK Secret Manager (@tetherto/wdk-secret-manager) encrypts seed at rest (PBKDF2 + XSalsa20-Poly1305)
 *   - The server-side AGENT wallet remains separate (per-vault EOA)
 *
 * Security:
 *   - Seed phrase encrypted at rest with WDK Secret Manager (@tetherto/wdk-secret-manager)
 *   - Private keys never leave the client process
 *   - SecureWalletSession uses ES private fields (#wallet) — LLM cannot access
 *   - WDK provides memory-safe key management with dispose()
 *   - Agent tools return only signatures and addresses, never keys
 */

// NOTE: WDK uses ethers.js internally, so this module runs in Node.js
// (or React Native), NOT in Cloudflare Workers. The server-side agent
// wallet uses viem and is a separate concern.

import type WalletManagerEvmType from "@tetherto/wdk-wallet-evm";
import type { SeedSignerEvm as SeedSignerEvmType } from "@tetherto/wdk-wallet-evm/signers";

/**
 * The auth message that the operator must sign to prove vault ownership.
 * Must match the server-side constant in auth.ts exactly.
 */
const OPERATOR_AUTH_MESSAGE =
  "Welcome to Rigoblock Operator\n\n" +
  "Sign this message to verify your wallet and access your smart pool assistant.";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WdkWalletConfig {
  /** RPC URL for the chain the wallet operates on (default: Plasma for x402) */
  provider?: string;
  /** Account index for BIP-44 derivation (default: 0) */
  accountIndex?: number;
  /** Maximum fee for transfers in wei */
  transferMaxFee?: number | bigint;
}

export interface WdkWalletInfo {
  /** The wallet's checksummed Ethereum address */
  address: string;
  /** The seed phrase (only returned on creation — caller must persist) */
  seedPhrase?: string;
  /** BIP-44 derivation path used */
  derivationPath: string;
}

export interface OperatorAuth {
  operatorAddress: string;
  authSignature: string;
  authTimestamp: number;
}

// ─── Default RPC endpoints ──────────────────────────────────────────────────

const DEFAULT_PLASMA_RPC = "https://rpc.plasma.to";
const DEFAULT_STABLE_RPC = "https://rpc.stable.xyz";

// ─── WDK Wallet Manager ────────────────────────────────────────────────────

/**
 * Manages a WDK EVM wallet for x402 payments and operator auth.
 *
 * Usage:
 *   // Create a new wallet (seed phrase generated automatically)
 *   const { wallet, info } = await RigoblockWallet.create();
 *   console.log("Save this seed phrase:", info.seedPhrase);
 *
 *   // Load an existing wallet
 *   const wallet = await RigoblockWallet.fromSeedPhrase("word1 word2 ...");
 *
 *   // Sign operator auth
 *   const auth = await wallet.signOperatorAuth();
 *
 *   // Get the WDK account for x402 (satisfies ClientEvmSigner)
 *   const signer = wallet.getAccount();
 */
export class RigoblockWallet {
  private manager: InstanceType<typeof WalletManagerEvmType>;
  private account: Awaited<ReturnType<InstanceType<typeof WalletManagerEvmType>["getAccount"]>>;
  private _address: string;

  private constructor(
    manager: InstanceType<typeof WalletManagerEvmType>,
    account: Awaited<ReturnType<InstanceType<typeof WalletManagerEvmType>["getAccount"]>>,
    address: string,
  ) {
    this.manager = manager;
    this.account = account;
    this._address = address;
  }

  // ─── Factory Methods ────────────────────────────────────────────────────

  /**
   * Create a new wallet with a randomly generated seed phrase.
   * The seed phrase is returned in the info object — the caller MUST
   * persist it securely (it won't be shown again).
   */
  static async create(
    config?: WdkWalletConfig,
  ): Promise<{ wallet: RigoblockWallet; info: WdkWalletInfo }> {
    const WalletManagerEvm = (await import("@tetherto/wdk-wallet-evm")).default;
    const { SeedSignerEvm } = await import("@tetherto/wdk-wallet-evm/signers");

    const seedPhrase = WalletManagerEvm.getRandomSeedPhrase();
    const provider = config?.provider ?? DEFAULT_PLASMA_RPC;
    const index = config?.accountIndex ?? 0;

    const signer = new SeedSignerEvm(seedPhrase, {
      provider,
      transferMaxFee: config?.transferMaxFee,
    });
    const manager = new WalletManagerEvm(signer, {
      provider,
      transferMaxFee: config?.transferMaxFee,
    });
    const account = await manager.getAccount(index);
    const address = await account.getAddress();

    const wallet = new RigoblockWallet(manager, account, address);
    const info: WdkWalletInfo = {
      address,
      seedPhrase,
      derivationPath: `m/44'/60'/0'/0/${index}`,
    };

    return { wallet, info };
  }

  /**
   * Load an existing wallet from a seed phrase.
   */
  static async fromSeedPhrase(
    seedPhrase: string,
    config?: WdkWalletConfig,
  ): Promise<RigoblockWallet> {
    const WalletManagerEvm = (await import("@tetherto/wdk-wallet-evm")).default;
    const { SeedSignerEvm } = await import("@tetherto/wdk-wallet-evm/signers");

    if (!WalletManagerEvm.isValidSeedPhrase(seedPhrase)) {
      throw new Error("Invalid BIP-39 seed phrase");
    }

    const provider = config?.provider ?? DEFAULT_PLASMA_RPC;
    const index = config?.accountIndex ?? 0;

    const signer = new SeedSignerEvm(seedPhrase, {
      provider,
      transferMaxFee: config?.transferMaxFee,
    });
    const manager = new WalletManagerEvm(signer, {
      provider,
      transferMaxFee: config?.transferMaxFee,
    });
    const account = await manager.getAccount(index);
    const address = await account.getAddress();

    return new RigoblockWallet(manager, account, address);
  }

  // ─── Account & Address ──────────────────────────────────────────────────

  /** The wallet's checksummed Ethereum address. */
  get address(): string {
    return this._address;
  }

  /**
   * Returns the underlying WDK account.
   * This satisfies the x402 `ClientEvmSigner` interface directly —
   * pass it to `registerExactEvmScheme(client, { signer: account })`.
   */
  getAccount(): typeof this.account {
    return this.account;
  }

  // ─── Operator Auth ──────────────────────────────────────────────────────

  /**
   * Sign the operator auth message to prove vault ownership.
   * Returns the signature, address, and timestamp needed for delegated mode.
   */
  async signOperatorAuth(): Promise<OperatorAuth> {
    const signature = await this.account.sign(OPERATOR_AUTH_MESSAGE);
    return {
      operatorAddress: this._address,
      authSignature: signature,
      authTimestamp: Date.now(),
    };
  }

  /**
   * Returns the auth message that would be signed.
   * Useful for displaying to the user before signing.
   */
  static getAuthMessage(): string {
    return OPERATOR_AUTH_MESSAGE;
  }

  // ─── Balance Helpers ────────────────────────────────────────────────────

  /** Get the native token (ETH/gas) balance in wei. */
  async getBalance(): Promise<bigint> {
    return this.account.getBalance();
  }

  /** Get an ERC-20 token balance (e.g., USDT0 on Plasma). */
  async getTokenBalance(tokenAddress: string): Promise<bigint> {
    return this.account.getTokenBalance(tokenAddress);
  }

  /**
   * Get USDT0 balance on Plasma.
   * Convenience method — uses the known Plasma USDT0 contract address.
   */
  async getUsdt0Balance(): Promise<bigint> {
    const USDT0_PLASMA = "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb";
    return this.account.getTokenBalance(USDT0_PLASMA);
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  /**
   * Dispose the wallet, clearing private keys from memory.
   * Call this when done — especially in long-running processes.
   */
  dispose(): void {
    this.manager.dispose();
  }
}

// ─── Encrypted Wallet Store (WDK Secret Manager) ───────────────────────────

/**
 * Seed encryption using Tether's WDK Secret Manager (@tetherto/wdk-secret-manager).
 *
 * Algorithms (handled by the WDK package):
 *   - PBKDF2-SHA256 (100k iterations) for key derivation
 *   - XSalsa20-Poly1305 (libsodium secretbox) for authenticated encryption
 *   - BIP-39 entropy ↔ mnemonic conversion
 *
 * Note: bare-crypto (a WDK dependency) requires a postinstall patch to work
 * in Node.js — see patches/patch-bare-crypto.cjs. The patch redirects
 * bare-crypto to node:crypto, which provides the same pbkdf2Sync API.
 * This is documented by Tether: "Node.js: Uses sodium-native and Node crypto."
 */

/**
 * Persisted format for an encrypted wallet. Store this as a JSON file.
 * The passkey is NOT stored — it must be provided at unlock time.
 */
export interface EncryptedWalletStore {
  /** Format version */
  version: 1;
  /** Wallet address (for verification without decrypting) */
  address: string;
  /** Base64-encoded 16-byte salt (unique per wallet, not secret) */
  salt: string;
  /** Base64-encoded encrypted entropy payload (WDK Secret Manager format) */
  encryptedEntropy: string;
}

// ─── Secure Wallet Session ─────────────────────────────────────────────────

/**
 * A secure wrapper around RigoblockWallet that prevents key leakage.
 *
 * Uses ES private class fields (#wallet) so the underlying wallet is
 * inaccessible from outside the class — even by the LLM agent that calls
 * tool functions. The agent only sees: address, signatures, balances.
 *
 * Lifecycle:
 *   1. Human creates wallet → SecureWalletSession.createEncrypted(passkey)
 *      - Returns session (for immediate use) + store (persist to file)
 *      - Seed phrase shown ONCE for offline backup
 *   2. Agent auto-unlocks → SecureWalletSession.unlock(passkey, store)
 *      - passkey from WALLET_PASSKEY env var (set once by human)
 *      - store from ~/.openclaw/rigoblock-wallet.enc.json
 *   3. Agent runs autonomously — signs x402, auth, transactions
 *   4. Human kill switch: remove WALLET_PASSKEY env var, or revoke delegation
 *
 * WDK Secret Manager encryption:
 *   passkey + salt → PBKDF2-SHA256 (100k iterations) → XSalsa20-Poly1305
 */
export class SecureWalletSession {
  /** Private — the LLM agent and tool code cannot access this field */
  #wallet: RigoblockWallet;

  private constructor(wallet: RigoblockWallet) {
    this.#wallet = wallet;
  }

  // ─── Public API (safe to expose to agent tools) ───────────────────────

  /** The wallet's checksummed address. Not sensitive. */
  get address(): string {
    return this.#wallet.address;
  }

  /**
   * Sign the operator auth message. Returns only the signature —
   * the private key never leaves this class.
   */
  async signOperatorAuth(): Promise<OperatorAuth> {
    return this.#wallet.signOperatorAuth();
  }

  /**
   * Returns the underlying WDK account for x402 signing.
   * The account satisfies the ClientEvmSigner interface and can sign
   * payment headers, but does not expose the raw private key.
   */
  getAccount(): ReturnType<RigoblockWallet["getAccount"]> {
    return this.#wallet.getAccount();
  }

  /** Get native token (ETH) balance in wei. */
  async getBalance(): Promise<bigint> {
    return this.#wallet.getBalance();
  }

  /** Get USDT0 balance on Plasma. */
  async getUsdt0Balance(): Promise<bigint> {
    return this.#wallet.getUsdt0Balance();
  }

  /** Get any ERC-20 token balance. */
  async getTokenBalance(tokenAddress: string): Promise<bigint> {
    return this.#wallet.getTokenBalance(tokenAddress);
  }

  // ─── Factory: Create New + Encrypt ────────────────────────────────────

  /**
   * Create a new WDK wallet and encrypt the seed with a passkey.
   *
   * The seed phrase is returned ONCE in `seedPhraseBackup` — the human
   * must save it as an offline recovery method. After this call, the seed
   * only exists in encrypted form (in `store`) and in process memory
   * (via the returned `session`).
   *
   * @param passkey - Human-chosen passkey (min 12 chars). Used for PBKDF2.
   * @param config  - Optional WDK wallet config (RPC, account index, etc.)
   * @returns session (for immediate signing), store (persist to disk), seedPhraseBackup (show once)
   */
  static async createEncrypted(
    passkey: string,
    config?: WdkWalletConfig,
  ): Promise<{
    session: SecureWalletSession;
    store: EncryptedWalletStore;
    seedPhraseBackup: string;
  }> {
    if (passkey.length < 12) {
      throw new Error("Passkey must be at least 12 characters");
    }

    // Use WDK Secret Manager for encryption
    const { WdkSecretManager, wdkSaltGenerator } = await import("@tetherto/wdk-secret-manager");

    const salt = wdkSaltGenerator.generate();
    const sm = new WdkSecretManager(passkey, salt);

    // Generate entropy + encrypt in one shot
    const { encryptedEntropy } = await sm.generateAndEncrypt();

    // Decrypt to get mnemonic (for wallet loading + backup)
    const entropy = sm.decrypt(encryptedEntropy);
    const mnemonic = sm.entropyToMnemonic(entropy);

    // Serialize BEFORE dispose — dispose() zeros the salt buffer in-place
    const saltB64 = Buffer.from(salt).toString("base64");
    const encryptedEntropyB64 = Buffer.from(encryptedEntropy).toString("base64");
    sm.dispose();

    // Load wallet from the generated mnemonic via WDK
    const wallet = await RigoblockWallet.fromSeedPhrase(mnemonic, config);

    const store: EncryptedWalletStore = {
      version: 1,
      address: wallet.address,
      salt: saltB64,
      encryptedEntropy: encryptedEntropyB64,
    };

    return {
      session: new SecureWalletSession(wallet),
      store,
      seedPhraseBackup: mnemonic,
    };
  }

  // ─── Factory: Unlock from Encrypted Store ─────────────────────────────

  /**
   * Unlock an encrypted wallet. Decrypts the seed, loads the wallet into
   * memory, then wipes the passkey and plaintext seed.
   *
   * The passkey typically comes from an environment variable
   * (WALLET_PASSKEY) — set once by the human, auto-unlocks on restart.
   *
   * @param passkey - The passkey used during createEncrypted()
   * @param store   - The persisted EncryptedWalletStore (from disk)
   * @param config  - Optional WDK wallet config
   */
  static async unlock(
    passkey: string,
    store: EncryptedWalletStore,
    config?: WdkWalletConfig,
  ): Promise<SecureWalletSession> {
    const { WdkSecretManager } = await import("@tetherto/wdk-secret-manager");

    const salt = Buffer.from(store.salt, "base64");
    const encryptedEntropy = Buffer.from(store.encryptedEntropy, "base64");

    const sm = new WdkSecretManager(passkey, salt);
    const entropy = sm.decrypt(encryptedEntropy);
    const mnemonic = sm.entropyToMnemonic(entropy);
    sm.dispose();

    const wallet = await RigoblockWallet.fromSeedPhrase(mnemonic, config);

    // Verify address matches the stored one (wrong passkey → wrong seed → wrong address)
    if (wallet.address.toLowerCase() !== store.address.toLowerCase()) {
      wallet.dispose();
      throw new Error(
        "Wallet address mismatch — wrong passkey or corrupted store",
      );
    }

    return new SecureWalletSession(wallet);
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────

  /**
   * Wipe the wallet's private keys from memory.
   * Call this when the process shuts down.
   */
  dispose(): void {
    this.#wallet.dispose();
  }
}

// ─── File Helpers for Encrypted Store ───────────────────────────────────────

/**
 * Save an encrypted wallet store to a JSON file.
 * @param filePath - Path to write (e.g., ~/.openclaw/rigoblock-wallet.enc.json)
 * @param store    - The encrypted wallet store
 */
export async function saveEncryptedStore(
  filePath: string,
  store: EncryptedWalletStore,
): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/**
 * Load an encrypted wallet store from a JSON file.
 * @param filePath - Path to read (e.g., ~/.openclaw/rigoblock-wallet.enc.json)
 */
export async function loadEncryptedStore(
  filePath: string,
): Promise<EncryptedWalletStore> {
  const { readFile } = await import("node:fs/promises");
  const data = await readFile(filePath, "utf-8");
  return JSON.parse(data) as EncryptedWalletStore;
}

// ─── x402 Setup Helper ─────────────────────────────────────────────────────

/**
 * Create an x402-aware fetch function using a WDK wallet or secure session.
 *
 * The returned fetch automatically handles 402 Payment Required responses:
 *   1. Receives 402 → 2. Signs USDT0 payment → 3. Retries with X-PAYMENT header
 *
 * @param wallet - A RigoblockWallet or SecureWalletSession instance
 * @param network - x402 network ID (default: Plasma "eip155:9745")
 */
export async function createX402Fetch(
  wallet: RigoblockWallet | SecureWalletSession,
  network: string = "eip155:9745",
): Promise<typeof fetch> {
  // Dynamic imports — these are optional peer dependencies
  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");

  const client = new x402Client();
  // WalletAccountEvm from wdk-wallet-evm is wire-compatible with ClientEvmSigner
  registerExactEvmScheme(client, { signer: wallet.getAccount() as any });

  return wrapFetchWithPayment(fetch, client) as typeof fetch;
}

// ─── Full Setup Helper ─────────────────────────────────────────────────────

/**
 * One-shot setup: create WDK wallet + x402 fetch + RigoblockClient.
 *
 * This is the recommended way to get started:
 *
 *   const { client, wallet, auth } = await setupRigoblockClient({
 *     seedPhrase: "word1 word2 ...",    // or omit to create a new wallet
 *     vaultAddress: "0xYourVault",
 *     chainId: 42161,
 *     executionMode: "delegated",       // or "manual"
 *   });
 *
 *   // Use the client
 *   const quote = await client.getQuote({ sell: "ETH", buy: "USDC", amount: "1" });
 *
 * @returns The client, wallet, and auth credentials (if delegated mode)
 */
export interface SetupOptions {
  /** Existing seed phrase — omit to generate a new wallet */
  seedPhrase?: string;
  /** Vault contract address */
  vaultAddress: string;
  /** Default chain ID */
  chainId?: number;
  /** Execution mode */
  executionMode?: "manual" | "delegated";
  /** API base URL (default: production) */
  baseUrl?: string;
  /** RPC URL for WDK wallet (default: Plasma) */
  walletProvider?: string;
  /** x402 network ID (default: Plasma) */
  x402Network?: string;
}

export interface SetupResult {
  /** The configured RigoblockClient with x402 payment */
  client: import("./client.js").RigoblockClient;
  /** The WDK wallet instance */
  wallet: RigoblockWallet;
  /** Wallet info (includes seed phrase only when a new wallet is created) */
  walletInfo?: WdkWalletInfo;
  /** Operator auth (only in delegated mode) */
  auth?: OperatorAuth;
}

export async function setupRigoblockClient(
  options: SetupOptions,
): Promise<SetupResult> {
  const { RigoblockClient } = await import("./client.js");

  // 1. Create or load WDK wallet
  let wallet: RigoblockWallet;
  let walletInfo: WdkWalletInfo | undefined;

  if (options.seedPhrase) {
    wallet = await RigoblockWallet.fromSeedPhrase(options.seedPhrase, {
      provider: options.walletProvider,
    });
  } else {
    const result = await RigoblockWallet.create({
      provider: options.walletProvider,
    });
    wallet = result.wallet;
    walletInfo = result.info;
  }

  // 2. Create x402-aware fetch
  const fetchWithPayment = await createX402Fetch(
    wallet,
    options.x402Network,
  );

  // 3. Build client config
  const baseConfig = {
    baseUrl: options.baseUrl ?? "https://trader.rigoblock.com",
    vaultAddress: options.vaultAddress,
    chainId: options.chainId ?? 8453,
    executionMode: (options.executionMode ?? "manual") as "manual" | "delegated",
  };

  // 4. Sign operator auth if delegated mode requested
  let auth: OperatorAuth | undefined;
  if (options.executionMode === "delegated") {
    auth = await wallet.signOperatorAuth();
  }

  // 5. Create client
  const client = new RigoblockClient(
    {
      ...baseConfig,
      ...(auth
        ? {
            operatorAddress: auth.operatorAddress,
            authSignature: auth.authSignature,
            authTimestamp: auth.authTimestamp,
          }
        : {}),
    },
    fetchWithPayment,
  );

  return { client, wallet, walletInfo, auth };
}

// ─── Secure Setup Helper (Encrypted Wallet) ────────────────────────────────

/**
 * Setup options for the secure (encrypted wallet) flow.
 */
export interface SecureSetupOptions {
  /** Passkey for encrypting/decrypting the wallet (min 12 chars) */
  passkey: string;
  /** Path to the encrypted wallet file. If it exists, unlock; if not, create. */
  walletStorePath: string;
  /** Vault contract address */
  vaultAddress: string;
  /** Default chain ID (default: 42161 Arbitrum) */
  chainId?: number;
  /** Execution mode */
  executionMode?: "manual" | "delegated";
  /** API base URL (default: production) */
  baseUrl?: string;
  /** RPC URL for WDK wallet (default: Plasma) */
  walletProvider?: string;
  /** x402 network ID (default: Plasma) */
  x402Network?: string;
}

export interface SecureSetupResult {
  /** The configured RigoblockClient with x402 payment */
  client: import("./client.js").RigoblockClient;
  /** The secure wallet session (signing only, no key access) */
  session: SecureWalletSession;
  /** Operator auth (only in delegated mode) */
  auth?: OperatorAuth;
  /** True if a NEW wallet was created (first run) */
  isNewWallet: boolean;
  /** Seed phrase backup — ONLY present when isNewWallet is true. Show once! */
  seedPhraseBackup?: string;
}

/**
 * One-shot secure setup: auto-create or auto-unlock encrypted wallet + x402 + client.
 *
 * First run:  Creates wallet → encrypts with passkey → saves store → returns session
 * Later runs: Loads store → decrypts with passkey → returns session
 *
 * The passkey comes from WALLET_PASSKEY env var — set once by the human.
 * The agent runs autonomously from then on.
 *
 * Usage:
 *   const result = await setupSecureClient({
 *     passkey: process.env.WALLET_PASSKEY!,
 *     walletStorePath: path.join(os.homedir(), ".openclaw", "rigoblock-wallet.enc.json"),
 *     vaultAddress: "0xYourVault",
 *     chainId: 42161,
 *     executionMode: "delegated",
 *   });
 *
 *   if (result.isNewWallet) {
 *     console.log("BACKUP THIS SEED PHRASE:", result.seedPhraseBackup);
 *   }
 */
export async function setupSecureClient(
  options: SecureSetupOptions,
): Promise<SecureSetupResult> {
  const { RigoblockClient } = await import("./client.js");
  const { existsSync } = await import("node:fs");

  let session: SecureWalletSession;
  let isNewWallet = false;
  let seedPhraseBackup: string | undefined;

  if (existsSync(options.walletStorePath)) {
    // Unlock existing encrypted wallet
    const store = await loadEncryptedStore(options.walletStorePath);
    session = await SecureWalletSession.unlock(options.passkey, store, {
      provider: options.walletProvider,
    });
  } else {
    // First run — create new wallet and encrypt
    const result = await SecureWalletSession.createEncrypted(options.passkey, {
      provider: options.walletProvider,
    });
    session = result.session;
    seedPhraseBackup = result.seedPhraseBackup;
    isNewWallet = true;

    // Persist the encrypted store
    await saveEncryptedStore(options.walletStorePath, result.store);
  }

  // Create x402-aware fetch
  const fetchWithPayment = await createX402Fetch(
    session,
    options.x402Network,
  );

  // Sign operator auth if delegated mode
  let auth: OperatorAuth | undefined;
  if (options.executionMode === "delegated") {
    auth = await session.signOperatorAuth();
  }

  // Build client
  const client = new RigoblockClient(
    {
      baseUrl: options.baseUrl ?? "https://trader.rigoblock.com",
      vaultAddress: options.vaultAddress,
      chainId: options.chainId ?? 42161,
      executionMode: (options.executionMode ?? "manual") as "manual" | "delegated",
      ...(auth
        ? {
            operatorAddress: auth.operatorAddress,
            authSignature: auth.authSignature,
            authTimestamp: auth.authTimestamp,
          }
        : {}),
    },
    fetchWithPayment,
  );

  return { client, session, auth, isNewWallet, seedPhraseBackup };
}
