declare module "sodium-universal" {
  const sodium: {
    randombytes_buf(buf: Buffer): void;
    crypto_secretbox_easy(c: Buffer, m: Buffer, n: Buffer, k: Buffer): void;
    crypto_secretbox_open_easy(
      m: Buffer,
      c: Buffer,
      n: Buffer,
      k: Buffer,
    ): boolean;
    crypto_secretbox_NONCEBYTES: number;
    crypto_secretbox_MACBYTES: number;
  };
  export default sodium;
}

declare module "bip39" {
  export function entropyToMnemonic(entropy: string): string;
  export function mnemonicToEntropy(mnemonic: string): string;
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
