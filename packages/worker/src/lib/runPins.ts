import type { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { ImplementerRuntimeKind } from '@auto-swe/shared/types/api';
import { resolveAgentRuntimeChoice } from './config/agentResolver.js';
import type { ResolveCtx } from './config/types.js';

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

/**
 * `{ agentKey: runtime | null }` for every agent the run can resolve: each
 * key's runtime as `resolveAgentRuntime` would read it from the Agent at this
 * moment (its own, or inherited along `inheritsModelFrom`), or `null` when the
 * Agent has no opinion and the caller's default will decide. Taken at run start
 * with the scope and agent-version pins the run's activities resolve with, and
 * written to `WorkflowRun.agentRuntimes`, so an edit to an agent — or to a
 * scoped override of it — after the run starts cannot change the loop the run
 * drives it with. A `null` pin is a pin too: a runtime added later does not
 * reach the run.
 *
 * A key whose resolution fails here (a broken `inheritsModelFrom` chain) is left
 * out, so the run fails on it where it is used, as it would have, and an agent
 * created after this point has no entry; both pin at first use instead.
 */
export async function snapshotAgentRuntimes(
  ctx: ResolveCtx
): Promise<Record<string, ImplementerRuntimeKind | null>> {
  const visible: Prisma.AgentWhereInput[] = [{ scope: 'GLOBAL' }];
  if (ctx.workflowTemplateId) {
    visible.push({ scope: 'WORKFLOW_TEMPLATE', workflowTemplateId: ctx.workflowTemplateId });
  }
  if (ctx.channelId) {
    visible.push({ channelId: ctx.channelId, scope: 'CHANNEL' });
  }
  if (ctx.teamId) {
    visible.push({ scope: 'TEAM', teamId: ctx.teamId });
  }
  if (ctx.orgId) {
    visible.push({ orgId: ctx.orgId, scope: 'ORGANIZATION' });
  }
  const rows = await runUnscoped(
    'GLOBAL agents have no tenant by definition; the template, channel, team and org rows are the run’s own',
    ['Agent'],
    () =>
      prisma.agent.findMany({
        distinct: ['key'],
        select: { key: true },
        where: { isActive: true, OR: visible },
      })
  );
  const pins: Record<string, ImplementerRuntimeKind | null> = {};
  await Promise.all(
    rows.map(async ({ key }) => {
      try {
        pins[key] = await resolveAgentRuntimeChoice(key, ctx);
      } catch {
        // Unresolvable now: it pins (or fails) where the run first uses it.
      }
    })
  );
  return pins;
}
