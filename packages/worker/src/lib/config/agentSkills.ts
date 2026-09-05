import { fetchActiveAgent, skillsFromAgent } from './agentResolver.js';
import { parseToolKeys } from './toolKeys.js';
import type { AnySkillRole, ResolveCtx, ResolvedSkill } from './types.js';

// `ResolvedSkill` now lives in ./types.js (shared by the resolver layers to
// avoid an import cycle); re-exported here for back-compat with existing imports.
export type { ResolvedSkill } from './types.js';

/**
 * Loads the effective skill fragments for an agent key from the first-class
 * `Agent` entity (P1.5 — the Agent's `skillRefs`). Reads the Agent row directly
 * (no model/credential resolution) so a skills-only caller can't fail on a
 * missing credential. Returns an empty array when the agent or its skills are
 * absent.
 */
export async function loadAgentSkills(
  role: AnySkillRole,
  ctx?: ResolveCtx
): Promise<ResolvedSkill[]> {
  const agent = await fetchActiveAgent(role, ctx);
  return agent ? skillsFromAgent(agent) : [];
}

/**
 * Joins skill prompt texts with a double newline separator, returning undefined
 * when the resulting string would be empty. Used to build optional system-prompt
 * suffixes for sub-role agents in the review network.
 */
export function skillsToPromptSuffix(skills: ResolvedSkill[]): string | undefined {
  return (
    skills
      .map((s) => s.promptText)
      .filter(Boolean)
      .join('\n\n') || undefined
  );
}

/**
 * Resolves the effective tool configuration for an agent key from the Agent's
 * `toolKeys` (P1.5). Returns the enabled tool keys, or null when the agent has
 * no tool override (caller uses all tools).
 */
export async function loadAgentToolConfig(
  role: AnySkillRole,
  ctx?: ResolveCtx
): Promise<string[] | null> {
  const agent = await fetchActiveAgent(role, ctx);
  return agent ? parseToolKeys(agent.toolKeys) : null;
}
