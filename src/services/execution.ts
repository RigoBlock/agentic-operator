/**
 * Execution Service — agent wallet transaction execution.
 *
 * In "delegated" mode, after the operator confirms transaction details,
 * the agent wallet signs and broadcasts the transaction using the
 * EIP-7702 delegation granted by the operator.
 *
 * Two execution paths:
 * 1. Direct execution: Agent wallet calls the vault directly
 *    (works when the delegation allows the agent to act as the operator)
 * 2. Delegation redemption: Agent wallet redeems a delegation through
 *    the DelegationManager, which executes the call from the operator's EOA
 *
 * Path 2 is necessary because Rigoblock vaults check msg.sender == owner.
 * With EIP-7702, the operator's EOA has delegation code set, so the agent
 * wallet calls into the operator's EOA, which then calls the vault.
 *
 * Result: vault sees msg.sender = operator address ✓
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type TransactionReceipt,
  type Chain,
  encodeFunctionData,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { Env, UnsignedTransaction, ExecutionResult } from "../types.js";
import { getChain, getRpcUrl } from "../config.js";
import { loadAgentWalletAccount } from "./agentWallet.js";
import { getDelegationConfig } from "./delegation.js";

const ALCHEMY_ORIGIN = "https://trader.rigoblock.com";

/** Timeout for waiting for a tx receipt (ms) */
const TX_CONFIRM_TIMEOUT_MS = 30_000;

// ── Delegation Manager ABI (subset for redeemDelegation) ──────────────
const DELEGATION_MANAGER_ABI = [
  {
    name: "redeemDelegation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "delegations", type: "bytes[]" },
      { name: "action", type: "tuple", components: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
      ]},
    ],
    outputs: [],
  },
] as const;

// ── Block explorer URLs ───────────────────────────────────────────────
const EXPLORER_TX_URL: Record<number, string> = {
  1: "https://etherscan.io/tx/",
  10: "https://optimistic.etherscan.io/tx/",
  56: "https://bscscan.com/tx/",
  137: "https://polygonscan.com/tx/",
  8453: "https://basescan.org/tx/",
  42161: "https://arbiscan.io/tx/",
  11155111: "https://sepolia.etherscan.io/tx/",
  84532: "https://sepolia.basescan.org/tx/",
};

/**
 * Execute a transaction via the agent wallet using EIP-7702 delegation.
 *
 * This redeems the operator's delegation to execute the vault call
 * through the operator's EOA, preserving msg.sender == operator.
 *
 * @param env - Worker environment bindings
 * @param tx - The unsigned transaction built by the agent
 * @param vaultAddress - The vault involved
 * @returns ExecutionResult with tx hash and confirmation status
 */
export async function executeViaDelegation(
  env: Env,
  tx: UnsignedTransaction,
  vaultAddress: string,
): Promise<ExecutionResult> {
  // 1. Load the delegation config
  const config = await getDelegationConfig(env.KV, vaultAddress);
  if (!config || !config.enabled) {
    throw new ExecutionError(
      "Delegation not configured. Enable delegated mode first.",
      "DELEGATION_NOT_CONFIGURED",
    );
  }

  // 2. Verify the transaction target is allowed
  if (tx.to.toLowerCase() !== config.vaultAddress.toLowerCase()) {
    throw new ExecutionError(
      `Transaction target ${tx.to} is not the delegated vault ${config.vaultAddress}`,
      "TARGET_NOT_ALLOWED",
    );
  }

  // 3. Verify the function selector is allowed
  const selector = tx.data.slice(0, 10) as Hex;
  if (!config.allowedSelectors.includes(selector)) {
    throw new ExecutionError(
      `Function selector ${selector} is not in the allowed delegation selectors`,
      "METHOD_NOT_ALLOWED",
    );
  }

  // 4. Load the agent wallet
  const agentAccount = await loadAgentWalletAccount(
    env.KV,
    vaultAddress,
    env.AGENT_WALLET_SECRET,
  );
  if (!agentAccount) {
    throw new ExecutionError(
      "Agent wallet not found for this vault",
      "AGENT_WALLET_NOT_FOUND",
    );
  }

  // 5. Verify agent address matches config
  if (agentAccount.address.toLowerCase() !== config.agentAddress.toLowerCase()) {
    throw new ExecutionError(
      "Agent wallet address mismatch with delegation config",
      "AGENT_WALLET_MISMATCH",
    );
  }

  // 6. Execute the transaction
  const chainId = tx.chainId;
  const result = await broadcastDelegatedTransaction(
    agentAccount,
    config.operatorAddress,
    tx,
    chainId,
    env.ALCHEMY_API_KEY,
  );

  return result;
}

/**
 * Broadcast a transaction through the delegation framework.
 *
 * The agent wallet calls redeemDelegation on the operator's EOA
 * (which has the DelegationManager code set via EIP-7702).
 * The DelegationManager validates caveats and forwards the call
 * to the vault, with msg.sender being the operator.
 */
async function broadcastDelegatedTransaction(
  agentAccount: PrivateKeyAccount,
  operatorAddress: Address,
  tx: UnsignedTransaction,
  chainId: number,
  alchemyKey?: string,
): Promise<ExecutionResult> {
  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId, alchemyKey);

  const transport = http(rpcUrl, rpcUrl?.includes("alchemy.com")
    ? { fetchOptions: { headers: { Origin: ALCHEMY_ORIGIN } } }
    : undefined,
  );

  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    account: agentAccount,
    chain,
    transport,
  });

  // Encode the redeemDelegation call to the operator's EOA.
  // The operator's EOA has the DelegationManager code set via EIP-7702,
  // so it can process delegation redemptions.
  const redeemCalldata = encodeFunctionData({
    abi: DELEGATION_MANAGER_ABI,
    functionName: "redeemDelegation",
    args: [
      [], // delegations chain (empty for root delegation)
      {
        to: tx.to,
        value: BigInt(tx.value),
        data: tx.data,
      },
    ],
  });

  // Send the transaction from the agent wallet to the operator's EOA
  console.log(`[Execution] Broadcasting delegated tx on chain ${chainId}`);
  console.log(`[Execution] Agent: ${agentAccount.address} → Operator EOA: ${operatorAddress} → Vault: ${tx.to}`);

  const txHash = await walletClient.sendTransaction({
    to: operatorAddress, // Call the operator's EOA (which has delegation code)
    data: redeemCalldata,
    value: BigInt(tx.value), // Pass through any ETH value (e.g., GMX execution fees)
    gas: BigInt(tx.gas) + BigInt(100_000), // Extra gas for delegation overhead
  });

  console.log(`[Execution] Tx sent: ${txHash}`);

  // Wait for confirmation
  let receipt: TransactionReceipt | null = null;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: TX_CONFIRM_TIMEOUT_MS,
    });
  } catch (err) {
    console.warn(`[Execution] Confirmation timeout for ${txHash}, returning pending`);
  }

  const explorerBase = EXPLORER_TX_URL[chainId];
  const explorerUrl = explorerBase ? `${explorerBase}${txHash}` : undefined;

  return {
    txHash,
    chainId,
    confirmed: receipt?.status === "success",
    blockNumber: receipt ? Number(receipt.blockNumber) : undefined,
    explorerUrl,
  };
}

/**
 * Check if the agent wallet has sufficient ETH for gas on a given chain.
 */
export async function checkAgentBalance(
  env: Env,
  vaultAddress: string,
  chainId: number,
): Promise<{ address: Address; balance: bigint; sufficient: boolean }> {
  const agentAccount = await loadAgentWalletAccount(
    env.KV,
    vaultAddress,
    env.AGENT_WALLET_SECRET,
  );
  if (!agentAccount) {
    throw new ExecutionError("Agent wallet not found", "AGENT_WALLET_NOT_FOUND");
  }

  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId, env.ALCHEMY_API_KEY);
  const transport = http(rpcUrl, rpcUrl?.includes("alchemy.com")
    ? { fetchOptions: { headers: { Origin: ALCHEMY_ORIGIN } } }
    : undefined,
  );
  const client = createPublicClient({ chain, transport });

  const balance = await client.getBalance({ address: agentAccount.address });
  // Consider sufficient if > 0.001 ETH (enough for ~5 txs on L2, 1 tx on mainnet)
  const MIN_BALANCE = BigInt("1000000000000000"); // 0.001 ETH

  return {
    address: agentAccount.address,
    balance,
    sufficient: balance >= MIN_BALANCE,
  };
}

/**
 * Custom error with error code for the API.
 */
export class ExecutionError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
  }
}
