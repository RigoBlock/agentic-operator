/**
 * Config tests — chain resolution, token maps, RPC URLs, sanitization.
 */
import { describe, it, expect } from "vitest";
import { parseGwei } from "viem";
import {
  getChain,
  resolveChainId,
  getRpcUrl,
  TOKEN_MAP,
  STAKING_PROXY,
  SUPPORTED_CHAINS,
  TESTNET_CHAINS,
  NATIVE_TOKEN,
  MIN_BALANCE,
  ALCHEMY_NETWORK,
  EXPLORER_TX_URL,
  getNativeTokenSymbol,
  getWrappedNativeAddress,
  sanitizeError,
  resolveTokenAddress,
} from "../src/config.js";
import { GAS_CAPS } from "../src/services/gas.js";

describe("getChain", () => {
  it("returns mainnet for chain 1", () => {
    const chain = getChain(1);
    expect(chain.id).toBe(1);
    expect(chain.name).toBe("Ethereum");
  });

  it("returns Base for chain 8453", () => {
    const chain = getChain(8453);
    expect(chain.id).toBe(8453);
  });

  it("returns Arbitrum for chain 42161", () => {
    const chain = getChain(42161);
    expect(chain.id).toBe(42161);
  });

  it("throws for unsupported chain", () => {
    expect(() => getChain(99999)).toThrow("Unsupported chain ID: 99999");
  });

  it("supports all 8 mainnet chains", () => {
    const expectedIds = [1, 10, 56, 130, 137, 999, 8453, 42161];
    for (const id of expectedIds) {
      expect(() => getChain(id)).not.toThrow();
    }
  });

  it("supports testnet chains", () => {
    expect(() => getChain(11155111)).not.toThrow(); // Sepolia
    expect(() => getChain(84532)).not.toThrow();    // Base Sepolia
  });

  it("exposes multicall3 on the HyperEVM chain definition", () => {
    const chain = getChain(999);
    expect(chain.contracts?.multicall3?.address).toBe(
      "0xcA11bde05977b3631167028862bE2a173976CA11",
    );
  });
});

describe("resolveChainId", () => {
  it("resolves numeric string", () => {
    expect(resolveChainId("8453")).toBe(8453);
  });

  it("resolves chain name (case-insensitive)", () => {
    expect(resolveChainId("Base")).toBe(8453);
    expect(resolveChainId("base")).toBe(8453);
    expect(resolveChainId("BASE")).toBe(8453);
  });

  it("resolves shortName", () => {
    expect(resolveChainId("arbitrum")).toBe(42161);
    expect(resolveChainId("ethereum")).toBe(1);
    expect(resolveChainId("bsc")).toBe(56);
    expect(resolveChainId("polygon")).toBe(137);
    expect(resolveChainId("optimism")).toBe(10);
    expect(resolveChainId("unichain")).toBe(130);
  });

  it("throws for unknown chain", () => {
    expect(() => resolveChainId("solana")).toThrow("Unknown chain: solana");
  });
});

describe("getRpcUrl", () => {
  it("returns correct Alchemy slug for each chain", () => {
    const expected: Record<number, string> = {
      1: "eth-mainnet",
      10: "opt-mainnet",
      130: "unichain-mainnet",
      137: "polygon-mainnet",
      8453: "base-mainnet",
      42161: "arb-mainnet",
    };
    for (const [chainId, slug] of Object.entries(expected)) {
      const url = getRpcUrl(Number(chainId));
      expect(url).toContain(slug);
    }
  });

  it("returns Alchemy URL for BSC", () => {
    const url = getRpcUrl(56);
    expect(url).toContain("bnb-mainnet");
  });

  it("returns Alchemy URL for HyperEVM", () => {
    expect(getRpcUrl(999)).toContain("hyperliquid-mainnet");
  });
});

describe("TOKEN_MAP", () => {
  it("has ETH on all EVM chains", () => {
    const ethChains = [1, 10, 130, 8453, 42161];
    for (const id of ethChains) {
      expect(TOKEN_MAP[id]?.ETH).toBe("0x0000000000000000000000000000000000000000");
    }
  });

  it("has BNB on BSC", () => {
    expect(TOKEN_MAP[56]?.BNB).toBe("0x0000000000000000000000000000000000000000");
  });

  it("has POL/MATIC on Polygon", () => {
    expect(TOKEN_MAP[137]?.POL).toBe("0x0000000000000000000000000000000000000000");
    expect(TOKEN_MAP[137]?.MATIC).toBe("0x0000000000000000000000000000000000000000");
  });

  it("has GRG on Ethereum", () => {
    expect(TOKEN_MAP[1]?.GRG).toBe("0x4FbB350052Bca5417566f188eB2EBCE5b19BC964");
  });

  it("has USDC on Arbitrum", () => {
    expect(TOKEN_MAP[42161]?.USDC).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
  });

  it("has USDC and WHYPE on HyperEVM", () => {
    expect(TOKEN_MAP[999]?.USDC).toBe("0xb88339CB7199b77E23DB6E890353E22632Ba630f");
    expect(TOKEN_MAP[999]?.WHYPE).toBe("0x5555555555555555555555555555555555555555");
    expect(getNativeTokenSymbol(999)).toBe("HYPE");
  });
});

describe("STAKING_PROXY", () => {
  it("has addresses for all 7 mainnet chains", () => {
    const chainIds = [1, 10, 56, 130, 137, 8453, 42161];
    for (const id of chainIds) {
      expect(STAKING_PROXY[id]).toBeDefined();
      expect(STAKING_PROXY[id]).toMatch(/^0x[a-fA-F0-9]{40}$/);
    }
  });
});

describe("SUPPORTED_CHAINS", () => {
  it("has 8 mainnet chains", () => {
    expect(SUPPORTED_CHAINS).toHaveLength(8);
  });

  it("each chain has id, name, and shortName", () => {
    for (const chain of SUPPORTED_CHAINS) {
      expect(chain.id).toBeTypeOf("number");
      expect(chain.name).toBeTypeOf("string");
      expect(chain.shortName).toBeTypeOf("string");
    }
  });
});

describe("sanitizeError", () => {
  it("strips RPC URLs", () => {
    const dirty = "Error at https://eth-mainnet.g.alchemy.com/v2/secretkey123: bad request";
    const clean = sanitizeError(dirty);
    expect(clean).not.toContain("secretkey123");
    expect(clean).toContain("[RPC_URL]");
  });

  it("strips bare API keys", () => {
    const dirty = "API key abcdef1234567890abcdef1234567890ab is invalid";
    const clean = sanitizeError(dirty);
    expect(clean).toContain("[REDACTED]");
    expect(clean).not.toContain("abcdef1234567890abcdef1234567890ab");
  });

  it("preserves Ethereum addresses (0x-prefixed)", () => {
    const dirty = "Transfer to 0xCA35b7d915458EF540aDe6068dFe2F44E8fa733c failed";
    const clean = sanitizeError(dirty);
    expect(clean).toContain("0xCA35b7d915458EF540aDe6068dFe2F44E8fa733c");
  });

  it("extracts viem Details line", () => {
    const verbose = `HTTP request failed.\nURL: https://rpc.example.com\nHeaders: ...\nDetails: execution reverted\nVersion: viem@2.0.0`;
    const clean = sanitizeError(verbose);
    expect(clean).toContain("execution reverted");
    expect(clean).not.toContain("Version:");
  });

  it("preserves CoinGecko diagnostic URLs", () => {
    const dirty = `CoinGecko rate-limited or blocked this IP (403) at https://api.coingecko.com/api/v3/search?query=LIT`;
    const clean = sanitizeError(dirty);
    expect(clean).toContain("https://api.coingecko.com/api/v3/search?query=LIT");
    expect(clean).not.toContain("[RPC_URL]");
  });
});

describe("resolveTokenAddress", () => {
  it("returns address as-is for 0x addresses", async () => {
    const addr = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    const result = await resolveTokenAddress(42161, addr);
    expect(result).toBe(addr);
  });

  it("resolves from static TOKEN_MAP", async () => {
    const result = await resolveTokenAddress(42161, "USDC");
    expect(result).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
  });

  it("resolves ETH to zero address on Ethereum (native)", async () => {
    const result = await resolveTokenAddress(1, "ETH");
    expect(result).toBe("0x0000000000000000000000000000000000000000");
  });

  it("resolves ETH to WETH on BNB Chain (bridged ERC-20)", async () => {
    const result = await resolveTokenAddress(56, "ETH");
    expect(result).toBe("0x2170Ed0880ac9A755fd29B2688956BD959F933F8");
  });

  it("resolves ETH to WETH on Polygon (bridged ERC-20)", async () => {
    const result = await resolveTokenAddress(137, "ETH");
    expect(result).toBe("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619");
  });

  it("resolves BNB to zero address on BNB Chain (native)", async () => {
    const result = await resolveTokenAddress(56, "BNB");
    expect(result).toBe("0x0000000000000000000000000000000000000000");
  });

  it("resolves POL to zero address on Polygon (native)", async () => {
    const result = await resolveTokenAddress(137, "POL");
    expect(result).toBe("0x0000000000000000000000000000000000000000");
  });
});

describe("NATIVE_TOKEN consistency", () => {
  it("every supported chain has a NATIVE_TOKEN entry", () => {
    for (const chain of SUPPORTED_CHAINS) {
      expect(NATIVE_TOKEN[chain.id], `Chain ${chain.name} (${chain.id}) missing NATIVE_TOKEN`)
        .toBeDefined();
      expect(NATIVE_TOKEN[chain.id]).not.toBe("");
    }
  });

  it("every supported chain has native symbol mapped to 0x0 in TOKEN_MAP", () => {
    for (const chain of SUPPORTED_CHAINS) {
      const nativeSymbol = getNativeTokenSymbol(chain.id);
      const tokenMap = TOKEN_MAP[chain.id];
      expect(tokenMap, `Chain ${chain.name} (${chain.id}) missing TOKEN_MAP`).toBeDefined();
      expect(
        tokenMap![nativeSymbol],
        `Chain ${chain.name}: ${nativeSymbol} must map to 0x0`,
      ).toBe("0x0000000000000000000000000000000000000000");
    }
  });

  it("every supported chain has W${nativeSymbol} in TOKEN_MAP", () => {
    for (const chain of SUPPORTED_CHAINS) {
      const nativeSymbol = getNativeTokenSymbol(chain.id);
      const wrappedKey = `W${nativeSymbol}`;
      const tokenMap = TOKEN_MAP[chain.id];
      expect(
        tokenMap![wrappedKey],
        `Chain ${chain.name}: ${wrappedKey} must be in TOKEN_MAP`,
      ).toBeDefined();
    }
  });

  it("getWrappedNativeAddress returns consistent addresses for known chains", () => {
    expect(getWrappedNativeAddress(1)).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");      // WETH
    expect(getWrappedNativeAddress(56)).toBe("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");     // WBNB
    expect(getWrappedNativeAddress(137)).toBe("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270");   // WPOL/WMATIC
    expect(getWrappedNativeAddress(8453)).toBe("0x4200000000000000000000000000000000000006");   // WETH
  });

  it("getNativeTokenSymbol returns correct symbols", () => {
    expect(getNativeTokenSymbol(1)).toBe("ETH");
    expect(getNativeTokenSymbol(56)).toBe("BNB");
    expect(getNativeTokenSymbol(137)).toBe("POL");
  });
});

describe("per-chain config completeness", () => {
  // These invariants guard the exact failure class that shipped to production
  // when HyperEVM (999) was added to SUPPORTED_CHAINS without a GAS_CAPS
  // entry: every user-facing chain selector entry must be fully operational
  // end-to-end (RPC, gas estimation, execution balance check, explorer links).
  const allChains = [...SUPPORTED_CHAINS, ...TESTNET_CHAINS];

  it("every selectable chain has gas caps, min balance, RPC, and explorer config", () => {
    for (const chain of allChains) {
      const caps = GAS_CAPS[chain.id];
      expect(caps, `${chain.name} (${chain.id}) missing GAS_CAPS`).toBeDefined();
      expect(caps!.maxFeePerGas, `${chain.name}: maxFeePerGas must be > 0`).toBeGreaterThan(0n);
      expect(caps!.maxPriorityFee, `${chain.name}: maxPriorityFee must be > 0`).toBeGreaterThan(0n);
      expect(
        caps!.maxFeePerGas >= caps!.maxPriorityFee,
        `${chain.name}: maxFeePerGas must be >= maxPriorityFee`,
      ).toBe(true);

      expect(MIN_BALANCE[chain.id], `${chain.name} (${chain.id}) missing MIN_BALANCE`).toBeDefined();
      expect(MIN_BALANCE[chain.id], `${chain.name}: MIN_BALANCE must be > 0`).toBeGreaterThan(0n);

      expect(ALCHEMY_NETWORK[chain.id], `${chain.name} (${chain.id}) missing ALCHEMY_NETWORK`).toMatch(/^[a-z0-9-]+$/);
      expect(EXPLORER_TX_URL[chain.id], `${chain.name} (${chain.id}) missing EXPLORER_TX_URL`).toMatch(/^https:\/\//);

      expect(() => getChain(chain.id), `${chain.name} (${chain.id}) missing viem chain definition`).not.toThrow();
    }
  });

  it("no config exists for chains we have no chain definition for", () => {
    // Reverse direction: catches stale per-chain config left behind when a
    // chain is removed from chainMap.
    for (const map of [GAS_CAPS, MIN_BALANCE, ALCHEMY_NETWORK, EXPLORER_TX_URL, TOKEN_MAP, NATIVE_TOKEN]) {
      for (const key of Object.keys(map)) {
        expect(
          () => getChain(Number(key)),
          `chain ${key} has config but no viem chain definition`,
        ).not.toThrow();
      }
    }
  });

  it("HyperEVM gas caps keep the operator-tuned values (100 / 0.02 gwei)", () => {
    expect(GAS_CAPS[999]?.maxFeePerGas).toBe(parseGwei("100"));
    expect(GAS_CAPS[999]?.maxPriorityFee).toBe(parseGwei("0.02"));
  });
});
