import type { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

/**
 * `{ agentKey: version }` of the latest active GLOBAL Agent per key: the
 * agent-version pin a run carries in `WorkflowRun.agentVersions`.
 */
export async function snapshotAgentVersions(): Promise<Record<string, number>> {
  const agents = await runUnscoped(
    'GLOBAL-scope rows are the deployment-wide defaults; they have no tenant by definition',
    ['Agent'],
    () =>
      prisma.agent.findMany({
        select: { key: true, version: true },
        where: { isActive: true, scope: 'GLOBAL' },
      })
  );
  const pins: Record<string, number> = {};
  for (const a of agents) {
    pins[a.key] = Math.max(pins[a.key] ?? 0, a.version);
  }
  return pins;
}

/**
 * `{ skillId: currentRevision }` for every skill visible to the run's tenant:
 * GLOBAL, plus the team's and organization's own. Keyed by skill id, so it does
 * not matter which agent later references a skill — an explicit `key@version`
 * ref, a CHANNEL-scope agent, or a skill attached to an agent after the run
 * began all find their pin. A skill created after this point has no entry and
 * resolves its current revision, which is also its only one.
 */
export async function snapshotSkillRevisions(scope: {
  orgId?: string;
  teamId?: string;
}): Promise<Record<string, number>> {
  const visible: Prisma.SkillWhereInput[] = [{ scope: 'GLOBAL' }];
  if (scope.teamId) {
    visible.push({ scope: 'TEAM', teamId: scope.teamId });
  }
  if (scope.orgId) {
    visible.push({ orgId: scope.orgId, scope: 'ORGANIZATION' });
  }
  const skills = await runUnscoped(
    'GLOBAL skills have no tenant by definition; the team and org rows are the run’s own',
    ['Skill'],
    () =>
      prisma.skill.findMany({
        select: { currentRevision: true, id: true },
        where: { OR: visible },
      })
  );
  const pins: Record<string, number> = {};
  for (const skill of skills) {
    pins[skill.id] = skill.currentRevision;
  }
  return pins;
}
