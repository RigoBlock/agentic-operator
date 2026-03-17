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
 *   - The server-side AGENT wallet remains separate (per-vault EOA)
 *
 * Security:
 *   - Seed phrase is handled in-memory only
 *   - Private keys never leave the client process
 *   - WDK provides memory-safe key management with dispose()
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

// ─── x402 Setup Helper ─────────────────────────────────────────────────────

/**
 * Create an x402-aware fetch function using a WDK wallet.
 *
 * The returned fetch automatically handles 402 Payment Required responses:
 *   1. Receives 402 → 2. Signs USDT0 payment → 3. Retries with X-PAYMENT header
 *
 * Usage:
 *   const wallet = await RigoblockWallet.fromSeedPhrase(seed);
 *   const fetchWithPayment = await createX402Fetch(wallet);
 *   const client = new RigoblockClient(config, fetchWithPayment);
 *
 * @param wallet - A RigoblockWallet instance
 * @param network - x402 network ID (default: Plasma "eip155:9745")
 */
export async function createX402Fetch(
  wallet: RigoblockWallet,
  network: string = "eip155:9745",
): Promise<typeof fetch> {
  // Dynamic imports — these are optional peer dependencies
  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");

  const client = new x402Client();
  registerExactEvmScheme(client, { signer: wallet.getAccount() });

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
