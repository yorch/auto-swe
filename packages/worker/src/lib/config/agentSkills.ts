import { prisma } from '@auto-swe/shared/db';
import type { AgentRole, ResolveCtx } from './types.js';

// Future: CUSTOM_TOOL entries in agent_tool_configs could reference sandboxed
// JS/Python stored in the DB, executed inside the Docker workspace with the same
// isolation model as built-in tools (Mastra createTool format). For now, only
// the 4 built-in keys are recognized.

export interface ResolvedSkill {
  id: string;
  name: string;
  promptText: string;
  sortOrder: number;
}

const ALL_TOOLS = ['readFile', 'writeFile', 'listDirectory', 'bash'] as const;
export type BuiltInToolKey = (typeof ALL_TOOLS)[number];

const ROLE_TO_PRISMA: Record<AgentRole, string> = {
  commitToMemory: 'COMMIT_TO_MEMORY',
  implementer: 'IMPLEMENTER',
  planner: 'PLANNER',
  reviewer: 'REVIEWER',
  securityReview: 'SECURITY_REVIEW',
  validateContext: 'VALIDATE_CONTEXT',
};

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
export async function loadAgentSkills(role: AgentRole, ctx?: ResolveCtx): Promise<ResolvedSkill[]> {
  const prismaRole = ROLE_TO_PRISMA[role];

  // 1. Workflow template scope
  if (ctx?.workflowTemplateId) {
    const rows = await fetchSkillAssignments(prismaRole, 'WORKFLOW_TEMPLATE', {
      workflowTemplateId: ctx.workflowTemplateId,
    });
    if (rows.length > 0) {
      return rows;
    }
  }

  // 2. Team scope
  if (ctx?.teamId) {
    const rows = await fetchSkillAssignments(prismaRole, 'TEAM', { teamId: ctx.teamId });
    if (rows.length > 0) {
      return rows;
    }
  }

  // 3. Global scope
  return fetchSkillAssignments(prismaRole, 'GLOBAL', {});
}

async function fetchSkillAssignments(
  prismaRole: string,
  scope: 'GLOBAL' | 'TEAM' | 'WORKFLOW_TEMPLATE',
  scopeFilter: { teamId?: string; workflowTemplateId?: string }
): Promise<ResolvedSkill[]> {
  const assignments = await prisma.agentSkillAssignment.findMany({
    include: { skill: true },
    orderBy: { sortOrder: 'asc' },
    // We cast `agentRole` and `scope` because the Prisma enum type and the
    // string we pass are identical at runtime but TypeScript cannot narrow
    // the imported enum to a narrower literal for the filter.
    where: {
      agentRole: prismaRole as 'IMPLEMENTER',
      scope: scope as 'GLOBAL',
      ...scopeFilter,
    },
  });
  return assignments.map((a) => ({
    id: a.skill.id,
    name: a.skill.name,
    promptText: a.skill.promptText,
    sortOrder: a.sortOrder,
  }));
}

/**
 * Resolves the effective tool configuration for an agent role.
 * Returns the enabled tool keys, or null if no config exists (caller uses all tools).
 * Cascade: WORKFLOW_TEMPLATE → TEAM → GLOBAL → null (use all tools).
 */
export async function loadAgentToolConfig(
  role: AgentRole,
  ctx?: ResolveCtx
): Promise<string[] | null> {
  const prismaRole = ROLE_TO_PRISMA[role];

  if (ctx?.workflowTemplateId) {
    const row = await prisma.agentToolConfig.findFirst({
      where: {
        agentRole: prismaRole as 'IMPLEMENTER',
        scope: 'WORKFLOW_TEMPLATE',
        workflowTemplateId: ctx.workflowTemplateId,
      },
    });
    if (row) {
      return row.enabledTools;
    }
  }

  if (ctx?.teamId) {
    const row = await prisma.agentToolConfig.findFirst({
      where: { agentRole: prismaRole as 'IMPLEMENTER', scope: 'TEAM', teamId: ctx.teamId },
    });
    if (row) {
      return row.enabledTools;
    }
  }

  const row = await prisma.agentToolConfig.findFirst({
    where: { agentRole: prismaRole as 'IMPLEMENTER', scope: 'GLOBAL' },
  });
  return row ? row.enabledTools : null; // null → caller uses all 4 tools
}
