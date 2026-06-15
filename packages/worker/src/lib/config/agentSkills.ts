import { prisma } from '@auto-swe/shared/db';
import type { AnySkillRole, ResolveCtx } from './types.js';

// Future: CUSTOM_TOOL type would reference a sandboxed JS/Python function stored in the DB.
// The worker would load and execute it within the Docker workspace, enforcing the same
// input/output schema contract as built-in tools (Mastra createTool format).
// Security model: custom tools run with the same Docker isolation as the workspace itself.

export interface ResolvedSkill {
  id: string;
  name: string;
  description: string;
  promptText: string;
  sortOrder: number;
  isVerified: boolean;
}

/**
 * Loads the effective skill assignments (prompt fragments) for an agent role
 * using the same scope cascade as ModelRoleConfig:
 * WORKFLOW_TEMPLATE → TEAM → GLOBAL.
 * The first scope that has any assignments for the role wins — returning
 * an empty array means "no prompt fragments injected" for this role.
 *
 * Called per-activity-invocation (not cached at startup) so that admin
 * edits take effect on the next LLM call within an already-running workflow.
 */
export async function loadAgentSkills(
  role: AnySkillRole,
  ctx?: ResolveCtx
): Promise<ResolvedSkill[]> {
  // 1. Workflow template scope
  if (ctx?.workflowTemplateId) {
    const rows = await fetchSkillAssignments(role, 'WORKFLOW_TEMPLATE', {
      workflowTemplateId: ctx.workflowTemplateId,
    });
    if (rows.length > 0) {
      return rows;
    }
  }

  // 2. Team scope
  if (ctx?.teamId) {
    const rows = await fetchSkillAssignments(role, 'TEAM', { teamId: ctx.teamId });
    if (rows.length > 0) {
      return rows;
    }
  }

  // 3. Global scope
  return fetchSkillAssignments(role, 'GLOBAL', {});
}

async function fetchSkillAssignments(
  agentRole: AnySkillRole,
  scope: 'GLOBAL' | 'TEAM' | 'WORKFLOW_TEMPLATE',
  scopeFilter: { teamId?: string; workflowTemplateId?: string }
): Promise<ResolvedSkill[]> {
  const assignments = await prisma.agentSkillAssignment.findMany({
    include: { skill: true },
    orderBy: { sortOrder: 'asc' },
    // `scope` is cast because the Prisma `ConfigScope` enum cannot be narrowed
    // from the local string-literal union for the filter. `agentRole` is a
    // plain TEXT column (camelCase string) so it needs no cast.
    where: {
      agentRole,
      scope: scope as 'GLOBAL',
      skill: { isActive: true },
      ...scopeFilter,
    },
  });
  return assignments.map((a) => ({
    description: a.skill.description ?? '',
    id: a.skill.id,
    isVerified: a.skill.isVerified,
    name: a.skill.name,
    promptText: a.skill.promptText,
    sortOrder: a.sortOrder,
  }));
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
 * Resolves the effective tool configuration for an agent role.
 * Returns the enabled tool keys, or null if no config exists (caller uses all tools).
 * Cascade: WORKFLOW_TEMPLATE → TEAM → GLOBAL → null (use all tools).
 */
export async function loadAgentToolConfig(
  role: AnySkillRole,
  ctx?: ResolveCtx
): Promise<string[] | null> {
  // 1. Workflow template scope
  if (ctx?.workflowTemplateId) {
    const row = await prisma.agentToolConfig.findFirst({
      where: {
        agentRole: role,
        scope: 'WORKFLOW_TEMPLATE',
        workflowTemplateId: ctx.workflowTemplateId,
      },
    });
    if (row) {
      return row.enabledTools;
    }
  }

  // 2. Team scope
  if (ctx?.teamId) {
    const row = await prisma.agentToolConfig.findFirst({
      where: {
        agentRole: role,
        scope: 'TEAM',
        teamId: ctx.teamId,
      },
    });
    if (row) {
      return row.enabledTools;
    }
  }

  // 3. Global scope
  const row = await prisma.agentToolConfig.findFirst({
    where: {
      agentRole: role,
      scope: 'GLOBAL',
      teamId: null,
      workflowTemplateId: null,
    },
  });
  return row?.enabledTools ?? null;
}
