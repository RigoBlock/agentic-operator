/**
 * Probe: does an EntryPoint v0.6 UserOperation carrying a REAL signed
 * EIP-7702 authorization pass Alchemy's eth_estimateUserOperationGas on
 * HyperEVM (chainId 999), for an account delegated to Alchemy's
 * SemiModularAccount7702?
 *
 * Junk signer only — ESTIMATION ONLY, no eth_sendUserOperation.
 * Reads ALCHEMY_API_KEY from .dev.vars (never prints it).
 *
 * Usage: npx tsx scripts/test-hyperliquid-v06-7702.ts
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createPublicClient, http, encodeFunctionData, toHex, type Hex } from "viem";
import { toSmartContractAccount, getEntryPoint } from "@aa-sdk/core";
import { modularAccountAbi } from "@account-kit/smart-contracts/experimental";
import { hyperliquid } from "@account-kit/infra";

const EP_V06 = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
const DELEGATE_V100 = "0x69007702764179f14F51cdce752f4f775d74E139";
const DELEGATE_V110 = "0x77021100bD87b7008E5E1989d0eB38555d0d0000";
const DUMMY_SIG =
  "0xFF00fffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c" as Hex;
const ORIGIN = "https://trader.rigoblock.com";

function loadAlchemyKey(): string {
  try {
    const raw = readFileSync(".dev.vars", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*ALCHEMY_API_KEY\s*=\s*"?([^"\s]+)"?\s*$/);
      if (m) return m[1];
    }
  } catch { /* fall through */ }
  const env = process.env.ALCHEMY_API_KEY;
  if (env) return env;
  throw new Error("ALCHEMY_API_KEY not found in .dev.vars or environment");
}

async function main() {
  const apiKey = loadAlchemyKey();
  const rpcUrl = `https://hyperliquid-mainnet.g.alchemy.com/v2/${apiKey}`;
  const junk = privateKeyToAccount(generatePrivateKey());
  console.log(`junk signer (sender/EOA): ${junk.address}`);

  const client = createPublicClient({
    chain: hyperliquid,
    transport: http(rpcUrl, { fetchOptions: { headers: { Origin: ORIGIN } } }),
  });

  // v0.6 EntryPointDef (aa-sdk's getEntryPoint with version + address override)
  const entryPoint = getEntryPoint(hyperliquid, {
    version: "0.6.0",
    addressOverride: EP_V06,
  });
  console.log(`entryPoint: v${entryPoint.version} @ ${entryPoint.address}`);

  // Custom SmartContractAccount — source intentionally NOT "ModularAccountV2"
  // to avoid the v0.7-only 7702 gate in initUserOperation.
  const account = await toSmartContractAccount({
    source: "ProbeSemiModular7702V06",
    transport: http(rpcUrl, { fetchOptions: { headers: { Origin: ORIGIN } } }),
    chain: hyperliquid,
    entryPoint,
    accountAddress: junk.address,
    getAccountInitCode: async () => "0x",
    // MAv2 standard-executor execute(address,uint256,bytes), same encoding as
    // modularAccountV2Base.encodeExecute.
    encodeExecute: async ({ target, value = 0n, data }) =>
      encodeFunctionData({
        abi: modularAccountAbi,
        functionName: "execute",
        args: [target, value, data],
      }),
    getDummySignature: async () => DUMMY_SIG,
    signUserOperationHash: async (uoHash) => junk.signMessage({ message: { raw: uoHash } }),
    signMessage: async ({ message }) => junk.signMessage({ message }),
    signTypedData: async (typedData) => junk.signTypedData(typedData as never),
  });
  console.log(`account address: ${account.address} (source=${account.source})`);

  // Nonce: MAv2 default = nonceKey 0, entityId 0 (DEFAULT_OWNER_ENTITY_ID),
  // global validation → fullNonceKey = (0 << 40) + (0 << 8) + 1 = 1.
  const fullNonceKey = 1n;
  const nonce = await account.getAccountNonce(fullNonceKey);
  console.log(`EP getNonce(sender, key=${fullNonceKey}) = ${nonce} (${toHex(nonce)})`);

  // Trivial call: execute(self, 0, "0x")
  const callData = await account.encodeExecute({ target: junk.address, value: 0n, data: "0x" });
  console.log(`encoded execute calldata: ${callData}`);

  // EIP-7702 authorization: nonce = EOA transaction count (0 for fresh junk key)
  const eoaTxCount = await client.getTransactionCount({ address: junk.address });
  console.log(`EOA transaction count (auth nonce): ${eoaTxCount}`);

  const gasPrice = await client.getGasPrice();
  const maxFeePerGas = toHex(gasPrice * 5n);
  const maxPriorityFeePerGas = toHex(gasPrice);
  console.log(`gasPrice=${gasPrice}, maxFeePerGas=${maxFeePerGas}, maxPriority=${maxPriorityFeePerGas}`);

  const baseUserOp = {
    sender: junk.address,
    nonce: toHex(nonce),
    initCode: "0x",
    callData,
    callGasLimit: "0x5208",
    verificationGasLimit: "0x186a00",
    preVerificationGas: "0x5208",
    maxFeePerGas,
    maxPriorityFeePerGas,
    paymasterAndData: "0x",
    signature: DUMMY_SIG,
  };

  // Iteration variants: (a) nonce key 0, (b) 0x1b/0x1c-style yParity, (c) control
  // with explicit stateOverride delegation code.
  const variants: Array<{
    label: string;
    nonceKey: bigint;
    yParityStyle: "raw" | "v";
    delegate: `0x${string}`;
    stateOverride?: unknown;
    realSig?: boolean;
  }> = [
    { label: "v1.0.0/key1", nonceKey: 1n, yParityStyle: "raw", delegate: DELEGATE_V100 },
    { label: "v1.0.0/key0", nonceKey: 0n, yParityStyle: "raw", delegate: DELEGATE_V100 },
    { label: "v1.0.0/key1/yParity=v", nonceKey: 1n, yParityStyle: "v", delegate: DELEGATE_V100 },
    { label: "v1.1.0/key1", nonceKey: 1n, yParityStyle: "raw", delegate: DELEGATE_V110 },
    {
      label: "v1.0.0/key1/stateOverride-control",
      nonceKey: 1n,
      yParityStyle: "raw",
      delegate: DELEGATE_V100,
      stateOverride: {
        [junk.address.toLowerCase()]: { code: `0xef0100${DELEGATE_V100.slice(2).toLowerCase()}` },
      },
    },
    {
      label: "v1.0.0/key1/stateOverride+realSig",
      nonceKey: 1n,
      yParityStyle: "raw",
      delegate: DELEGATE_V100,
      stateOverride: {
        [junk.address.toLowerCase()]: { code: `0xef0100${DELEGATE_V100.slice(2).toLowerCase()}` },
      },
      realSig: true,
    },
  ];

  let verdict = false;
  for (const v of variants) {
    const n = await account.getAccountNonce(v.nonceKey);
    const auth = await junk.signAuthorization({
      chainId: 999,
      contractAddress: v.delegate,
      nonce: eoaTxCount,
    });
    const yParityRaw = auth.yParity ?? Number(auth.v ?? 27n) - 27;
    const yParity = v.yParityStyle === "raw" ? toHex(yParityRaw) : toHex(yParityRaw + 27);
    const eip7702Auth = {
      chainId: toHex(999),
      nonce: toHex(eoaTxCount),
      address: auth.address,
      r: auth.r,
      s: auth.s,
      yParity,
    };
    let signature: Hex = DUMMY_SIG;
    const partial = { ...baseUserOp, nonce: toHex(n) };
    if (v.realSig) {
      // Sign the exact v0.6 userop hash (eip7702Auth is NOT part of the hash).
      const uoHash = account.getEntryPoint().getUserOperationHash({
        ...partial,
        eip7702Auth: undefined,
      } as never);
      signature = await account.signUserOperationHash(uoHash);
      console.log(`    signed uoHash ${uoHash} → sig ${signature.slice(0, 20)}…`);
    }
    const params: unknown[] = v.stateOverride
      ? [{ ...partial, signature, eip7702Auth }, EP_V06, v.stateOverride]
      : [{ ...partial, signature, eip7702Auth }, EP_V06];
    console.log(`\n>>> variant ${v.label}: nonce=${toHex(n)} yParity=${yParity} delegate=${v.delegate}`);
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_estimateUserOperationGas", params }),
    });
    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) {
      console.log(`❌ ${v.label}: ${json.error.message}`);
    } else {
      console.log(`✅ ${v.label} ESTIMATION PASSED:`, JSON.stringify(json.result));
      verdict = true;
    }
  }

  console.log(`\n================ VERDICT ================`);
  console.log(verdict
    ? "✅ v0.6 + real signed 7702 auth PASSES Alchemy eth_estimateUserOperationGas on HyperEVM"
    : "❌ v0.6 + real signed 7702 auth FAILED estimation on all delegate variants");
}

main().catch((err) => {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
