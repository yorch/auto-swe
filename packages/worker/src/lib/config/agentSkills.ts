import type { SkillType } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import type { AgentRole, ResolveCtx } from './types.js';

// Future: CUSTOM_TOOL type would reference a sandboxed JS/Python function stored in the DB.
// The worker would load and execute it within the Docker workspace, enforcing the same
// input/output schema contract as built-in tools (Mastra createTool format).
// Security model: custom tools run with the same Docker isolation as the workspace itself.

export interface ResolvedSkill {
  id: string;
  name: string;
  type: SkillType;
  toolKey: string | null;
  promptText: string | null;
  sortOrder: number;
}

const ROLE_TO_PRISMA: Record<AgentRole, string> = {
  commitToMemory: 'COMMIT_TO_MEMORY',
  implementer: 'IMPLEMENTER',
  planner: 'PLANNER',
  reviewer: 'REVIEWER',
  securityReview: 'SECURITY_REVIEW',
  validateContext: 'VALIDATE_CONTEXT',
};

/**
 * Loads the effective skill assignments for an agent role using the same
 * scope cascade as ModelRoleConfig: WORKFLOW_TEMPLATE → TEAM → GLOBAL.
 * The first scope that has any assignments for the role wins — returning
 * an empty array means "use hardcoded defaults" in the agent factory.
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
    toolKey: a.skill.toolKey,
    type: a.skill.type,
  }));
}
