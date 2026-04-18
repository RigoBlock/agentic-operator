/**
 * Strategy Skill Registry.
 *
 * Collects all strategy skills and exposes them to the system.
 * Adding a new strategy = create the skill file + add it here.
 */

import type { Env, RequestContext } from "../types.js";
import type { StrategySkill, SkillToolDefinition, SkillToolResult, ProcessChatFn } from "./types.js";
import { twapSkill } from "./twap.js";
import { navSyncSkill } from "./navsync.js";

// ── Register all skills here ──────────────────────────────────────────

const skills: StrategySkill[] = [
  twapSkill,
  navSyncSkill,
];

// ── Public API ────────────────────────────────────────────────────────

/** All tool definitions from all skills, for merging into the master tool list. */
export function getSkillTools(): SkillToolDefinition[] {
  return skills.flatMap(s => s.tools);
}

/** All tool names handled by skills — for the switch statement bypass. */
export function getSkillToolNames(): Set<string> {
  return new Set(skills.flatMap(s => s.toolNames));
}

/** System prompt sections from all skills, joined with newlines. */
export function getSkillSystemPrompt(): string {
  return skills.map(s => s.systemPrompt).join("\n\n");
}

/** Dispatch a tool call to the correct skill. Returns null if no skill handles it. */
export async function handleSkillToolCall(
  toolName: string,
  args: Record<string, unknown>,
  env: Env,
  ctx: RequestContext,
): Promise<SkillToolResult | null> {
  for (const skill of skills) {
    if (skill.toolNames.includes(toolName)) {
      return skill.handleToolCall(toolName, args, env, ctx);
    }
  }
  return null;
}

/** Run all skills' cron executors. Called from the scheduled() handler. */
export async function runAllSkills(env: Env, processChat: ProcessChatFn): Promise<void> {
  for (const skill of skills) {
    try {
      await skill.runDue(env, processChat);
    } catch (err) {
      console.error(`[Skills] ${skill.name} cron failed:`, err);
    }
  }
}
