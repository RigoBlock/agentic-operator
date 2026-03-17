declare module "@tetherto/wdk-secret-manager" {
  export const wdkSaltGenerator: {
    generate: () => Buffer;
  };
  export class WdkSecretManager {
    constructor(
      passKey: Buffer | ArrayBuffer | Uint8Array | string,
      salt?: Buffer,
    );
    generateAndEncrypt(
      payload?: Buffer,
      derivedKey?: Buffer,
    ): Promise<{ encryptedSeed: Buffer; encryptedEntropy: Buffer }>;
    decrypt(payload: Buffer, derivedKey?: Buffer): Buffer;
    generateRandomBuffer(): Buffer;
    entropyToMnemonic(entropy: Buffer): string;
    mnemonicToEntropy(seedPhrase: string): Buffer;
    dispose(): void;
  }
}

declare module "@x402/fetch" {
  export class x402Client {
    constructor();
  }
  export function wrapFetchWithPayment(
    fetchFn: typeof fetch,
    client: x402Client,
  ): typeof fetch;
}

declare module "@x402/evm/exact/client" {
  export function registerExactEvmScheme(
    client: any,
    config: { signer: any },
  ): void;
}
