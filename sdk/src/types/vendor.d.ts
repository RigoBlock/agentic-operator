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
