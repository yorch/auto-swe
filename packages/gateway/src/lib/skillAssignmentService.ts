import type { Prisma, PrismaClient } from '@auto-swe/shared';

/**
 * AgentSkillAssignment + AgentToolConfig service, shared by the admin routes
 * (`/api/v1/admin/agents/:role/...`) and the team-scoped routes
 * (`/api/v1/teams/:teamId/agents/:role/...`). Both variants call the same
 * functions parameterized by a scope key.
 *
 * IMPORTANT: both tables use partial unique indexes (`WHERE teamId IS NULL`
 * etc.), which Prisma cannot express in `upsert`. All writes therefore use
 * findFirst/deleteMany + create inside a transaction — never `upsert`.
 * (Documented in AGENTS.md §6.)
 */

export const SKILL_AGENT_ROLES = [
  'IMPLEMENTER',
  'REVIEWER',
  'PLANNER',
  'SECURITY_REVIEW',
  'VALIDATE_CONTEXT',
  'COMMIT_TO_MEMORY',
  'SECURITY_REVIEWER',
  'DOMAIN_LOGIC_REVIEWER',
  'PERFORMANCE_REVIEWER',
  'DECOMPOSER',
] as const;
export const SKILL_SCOPES = ['GLOBAL', 'TEAM', 'WORKFLOW_TEMPLATE'] as const;
export const IMPLEMENTER_TOOL_KEYS = ['readFile', 'writeFile', 'listDirectory', 'bash'] as const;

export type SkillAgentRole = (typeof SKILL_AGENT_ROLES)[number];
export type SkillScope = (typeof SKILL_SCOPES)[number];
export type ImplementerToolKey = (typeof IMPLEMENTER_TOOL_KEYS)[number];

export type AgentToolConfigRow = NonNullable<
  Awaited<ReturnType<PrismaClient['agentToolConfig']['findFirst']>>
>;
export type SkillAssignmentWithSkill = Prisma.AgentSkillAssignmentGetPayload<{
  include: { skill: true };
}>;

/// The (role, scope, teamId?, workflowTemplateId?) key that identifies one
/// logical assignment/config row. Missing scope qualifiers normalize to null
/// so the partial-unique-index columns are always matched explicitly.
export type AgentScopeKey = {
  agentRole: SkillAgentRole;
  scope: SkillScope;
  teamId?: string | null;
  workflowTemplateId?: string | null;
};

function scopeWhere(key: AgentScopeKey) {
  return {
    agentRole: key.agentRole,
    scope: key.scope,
    teamId: key.teamId ?? null,
    workflowTemplateId: key.workflowTemplateId ?? null,
  };
}

// ── Skill assignments ───────────────────────────────────────────────────────

export function listSkillAssignments(
  prisma: PrismaClient,
  key: AgentScopeKey
): Promise<SkillAssignmentWithSkill[]> {
  return prisma.agentSkillAssignment.findMany({
    include: { skill: true },
    orderBy: { sortOrder: 'asc' },
    where: scopeWhere(key),
  });
}

/// Replaces all assignments for the scope key in one transaction
/// (deleteMany + createMany — see the partial-unique-index note above),
/// then returns the fresh rows with skills included.
export async function replaceSkillAssignments(
  prisma: PrismaClient,
  key: AgentScopeKey,
  skillIds: string[],
  sortOrders?: number[]
) {
  await prisma.$transaction(async (tx) => {
    // Delete existing assignments for this role+scope
    await tx.agentSkillAssignment.deleteMany({ where: scopeWhere(key) });

    // Create new assignments
    if (skillIds.length > 0) {
      await tx.agentSkillAssignment.createMany({
        data: skillIds.map((skillId, idx) => ({
          ...scopeWhere(key),
          skillId,
          sortOrder: sortOrders?.[idx] ?? idx,
        })),
      });
    }
  });

  return listSkillAssignments(prisma, key);
}

export async function clearSkillAssignments(
  prisma: PrismaClient,
  key: AgentScopeKey
): Promise<void> {
  await prisma.agentSkillAssignment.deleteMany({ where: scopeWhere(key) });
}

// ── Tool configs ────────────────────────────────────────────────────────────

export function findToolConfig(
  prisma: PrismaClient,
  key: AgentScopeKey
): Promise<AgentToolConfigRow | null> {
  return prisma.agentToolConfig.findFirst({ where: scopeWhere(key) });
}

/// deleteMany + create in a transaction (partial unique indexes prevent
/// upsert on a named constraint). Returns `[previous, next]` so the caller
/// can audit-log CREATE vs UPDATE.
export function setToolConfig(
  prisma: PrismaClient,
  key: AgentScopeKey,
  enabledTools: ImplementerToolKey[]
): Promise<readonly [AgentToolConfigRow | null, AgentToolConfigRow]> {
  return prisma.$transaction(async (tx) => {
    const prev = await tx.agentToolConfig.findFirst({ where: scopeWhere(key) });
    await tx.agentToolConfig.deleteMany({ where: scopeWhere(key) });
    const next = await tx.agentToolConfig.create({
      data: { ...scopeWhere(key), enabledTools },
    });
    return [prev, next] as const;
  });
}

/// Deletes the tool config for the scope key (reset to inherit from the
/// parent scope). Returns the deleted row, or null when none existed, so the
/// caller can decide whether to audit-log.
export async function deleteToolConfig(
  prisma: PrismaClient,
  key: AgentScopeKey
): Promise<AgentToolConfigRow | null> {
  const existing = await prisma.agentToolConfig.findFirst({ where: scopeWhere(key) });
  await prisma.agentToolConfig.deleteMany({ where: scopeWhere(key) });
  return existing;
}

// ── Role overview ───────────────────────────────────────────────────────────

/// Lists every agent role with its GLOBAL skill-assignment count and GLOBAL
/// tool config (admin dashboard overview).
export async function getAgentRolesOverview(prisma: PrismaClient) {
  const [assignments, toolConfigs] = await Promise.all([
    prisma.agentSkillAssignment.groupBy({
      _count: { id: true },
      by: ['agentRole'],
      where: { scope: 'GLOBAL' },
    }),
    prisma.agentToolConfig.findMany({
      where: { scope: 'GLOBAL' },
    }),
  ]);

  const countByRole = Object.fromEntries(assignments.map((a) => [a.agentRole, a._count.id]));
  const toolConfigByRole = Object.fromEntries(toolConfigs.map((tc) => [tc.agentRole, tc]));

  return SKILL_AGENT_ROLES.map((role) => ({
    globalSkillCount: countByRole[role] ?? 0,
    role,
    toolConfig: toolConfigByRole[role] ?? null,
  }));
}

// ── Access checks ───────────────────────────────────────────────────────────

export type TeamAccessResult = { ok: true } | { message: string; ok: false };

/// Team-scoped access rule shared by every `/teams/:teamId/agents/...` route:
/// platform ADMINs always pass; otherwise the user must be a member of the
/// team, and (for writes) hold the team ADMIN role.
export async function checkTeamAccess(
  prisma: PrismaClient,
  user: { role: string; sub: string },
  teamId: string,
  opts: { requireTeamAdmin?: boolean } = {}
): Promise<TeamAccessResult> {
  if (user.role === 'ADMIN') {
    return { ok: true };
  }
  const membership = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { teamId, userId: user.sub } },
  });
  if (!membership) {
    return { message: 'Team membership required', ok: false };
  }
  if (opts.requireTeamAdmin && membership.role !== 'ADMIN') {
    return { message: 'Team admin role required', ok: false };
  }
  return { ok: true };
}

/// Validates that the teamId / workflowTemplateId scope qualifiers reference
/// existing rows, surfacing a 400-able message instead of an FK-violation 500.
export async function validateScopeRefs(
  prisma: PrismaClient,
  args: { teamId?: string; workflowTemplateId?: string }
): Promise<string | null> {
  if (args.teamId) {
    const teamExists = await prisma.team.findUnique({
      select: { id: true },
      where: { id: args.teamId },
    });
    if (!teamExists) {
      return 'Team not found';
    }
  }
  if (args.workflowTemplateId) {
    const tplExists = await prisma.workflowTemplate.findUnique({
      select: { id: true },
      where: { id: args.workflowTemplateId },
    });
    if (!tplExists) {
      return 'Workflow template not found';
    }
  }
  return null;
}
