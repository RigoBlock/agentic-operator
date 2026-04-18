/**
 * Strategy Skill Interface.
 *
 * Each strategy type (TWAP, LP rebalance, etc.) is a self-contained
 * skill module that implements this interface. Skills are composable — adding a
 * new strategy = creating a new file + registering it.
 *
 * A skill owns:
 *   - Its types (order/state shape)
 *   - Its tool definitions (what the LLM sees)
 *   - Its tool handlers (what happens when the LLM calls the tool)
 *   - Its cron executor (what happens on each tick)
 */

import type { Env, RequestContext, UnsignedTransaction, ChatMessage } from "../types.js";

/** Minimal tool definition for the LLM (matches OpenAI function calling schema). */
export interface SkillToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Result of handling a tool call. */
export interface SkillToolResult {
  message: string;
  transaction?: UnsignedTransaction;
  transactions?: UnsignedTransaction[];
  chainSwitch?: number;
  suggestions?: string[];
}

/** processChat signature used by cron executors to build swap calldata. */
export type ProcessChatFn = (
  env: Env,
  messages: ChatMessage[],
  ctx: RequestContext,
) => Promise<{
  reply?: string;
  transaction?: UnsignedTransaction;
  transactions?: UnsignedTransaction[];
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result?: string; error?: boolean }>;
  chainSwitch?: number;
}>;

export interface StrategySkill {
  /** Unique skill identifier (used in logs, KV prefix). */
  readonly name: string;

  /** Human-readable description. */
  readonly description: string;

  /** Tool definitions the LLM sees. Merged into the master tool list. */
  readonly tools: SkillToolDefinition[];

  /** System prompt section appended to the LLM's instructions. */
  readonly systemPrompt: string;

  /** Tool names this skill handles. Used for dispatch routing. */
  readonly toolNames: string[];

  /** Handle a tool call from the LLM. Return null if tool name not handled. */
  handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    env: Env,
    ctx: RequestContext,
  ): Promise<SkillToolResult | null>;

  /** Run due executions on cron tick. */
  runDue(env: Env, processChat: ProcessChatFn): Promise<void>;
}
