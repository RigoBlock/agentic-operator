/**
 * Debug: dump the raw READ_CORE position tuple for a vault/market so the
 * served layout can be aligned with known account state.
 *
 * Usage:
 *   LIGHTER_RPC_URL="https://evm-rpc.devnet.lighterevm.axiom.xyz" \
 *     npx tsx scripts/debug-lighter-position-raw.ts [vaultAddress] [marketId]
 */
import { createPublicClient, http, decodeAbiParameters, type Hex } from "viem";

const RPC_URL = process.env.LIGHTER_RPC_URL;
if (!RPC_URL) throw new Error("LIGHTER_RPC_URL is not set");

const VAULT = (process.argv[2] ?? "0x7Bcea99B22Caa039ff282519d404dF38fbaC6CB8") as `0x${string}`;
const MARKET_ID = Number(process.argv[3] ?? 0);

const READ_CORE = "0x6600000000000000000000000000000000000000" as `0x${string}`;

const client = createPublicClient({
  transport: http(RPC_URL, { timeout: 15_000, retryCount: 0 }),
});

function packPositionQuery(account: string, isL1: boolean, marketId: number): Hex {
  const u16 = (n: number) => n.toString(16).padStart(4, "0");
  return `0x${u16(0x0007)}${account.toLowerCase().slice(2)}${isL1 ? "01" : "00"}${u16(marketId)}` as Hex;
}

function packAccountQuery(account: string, isL1: boolean): Hex {
  const u16 = (n: number) => n.toString(16).padStart(4, "0");
  return `0x${u16(0x0001)}${account.toLowerCase().slice(2)}${isL1 ? "01" : "00"}` as Hex;
}

function words(raw: Hex): bigint[] {
  const out: bigint[] = [];
  for (let i = 2; i < raw.length; i += 64) {
    out.push(BigInt(`0x${raw.slice(i, i + 64)}`));
  }
  return out;
}

const raw = await client.call({
  to: READ_CORE,
  data: packPositionQuery(VAULT, false, MARKET_ID),
  blockTag: "latest",
});
const data = (raw.data ?? "0x") as Hex;
console.log(`position query: vault=${VAULT} market=${MARKET_ID}`);
console.log(`raw (${(data.length - 2) / 2} bytes):`);
const ws = words(data);
ws.forEach((w, i) => console.log(`  word${i}: ${w}`));

if (ws.length === 7) {
  const [position, entryQuote, imf, w3, w4, marginMode, allocatedMargin] = decodeAbiParameters(
    [
      { type: "int64" }, { type: "uint56" }, { type: "uint16" },
      { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "int128" },
    ],
    data,
  ) as readonly [bigint, bigint, number, bigint, bigint, number, bigint];
  console.log("7-word decode (current code):", {
    position: position.toString(),
    entryQuote: entryQuote.toString(),
    initialMarginFraction: imf,
    word3: w3.toString(),
    word4: w4.toString(),
    marginMode,
    allocatedMargin: allocatedMargin.toString(),
  });
} else if (ws.length === 8) {
  const [funding, position, entryQuote, imf, w3, w4, marginMode, allocatedMargin] = decodeAbiParameters(
    [
      { type: "int64" }, { type: "int64" }, { type: "uint56" }, { type: "uint16" },
      { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "int128" },
    ],
    data,
  ) as readonly [bigint, bigint, bigint, number, bigint, bigint, number, bigint];
  console.log("8-word decode (with leading funding):", {
    lastFundingRatePrefixSum: funding.toString(),
    position: position.toString(),
    entryQuote: entryQuote.toString(),
    initialMarginFraction: imf,
    word3: w3.toString(),
    word4: w4.toString(),
    marginMode,
    allocatedMargin: allocatedMargin.toString(),
  });
}

const accRaw = await client.call({
  to: READ_CORE,
  data: packAccountQuery(VAULT, false),
  blockTag: "latest",
});
const accData = (accRaw.data ?? "0x") as Hex;
const [accountType, accountIndex, masterIndex, l1, evm, collateral] = decodeAbiParameters(
  [
    { type: "uint8" }, { type: "uint48" }, { type: "uint48" },
    { type: "address" }, { type: "address" }, { type: "int128" },
  ],
  accData,
) as unknown as readonly [number, bigint, bigint, `0x${string}`, `0x${string}`, bigint];
console.log("account info:", {
  accountType: Number(accountType),
  accountIndex: accountIndex.toString(),
  masterIndex: masterIndex.toString(),
  l1,
  evm,
  collateralBase: collateral.toString(),
});
