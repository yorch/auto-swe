import type { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { ImplementerRuntimeKind } from '@auto-swe/shared/types/api';
import { resolveAgentProfileBinding, resolveAgentRuntimeChoice } from './config/agentResolver.js';
import {
  bindingNeedsEnablement,
  enabledProfileIds,
  enablementTeamId,
} from './config/pluginEnablement.js';
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
  const keys = await visibleAgentKeys(ctx);
  const pins: Record<string, ImplementerRuntimeKind | null> = {};
  await Promise.all(
    keys.map(async (key) => {
      try {
        pins[key] = await resolveAgentRuntimeChoice(key, ctx);
      } catch {
        // Unresolvable now: it pins (or fails) where the run first uses it.
      }
    })
  );
  return pins;
}

/** Every agent key with an active row visible to the run's scope. */
async function visibleAgentKeys(ctx: ResolveCtx): Promise<string[]> {
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
  return rows.map((r) => r.key);
}

/**
 * `{ profileName: version }` for every harness profile an agent the run can
 * resolve is bound to: the profile's latest version at this moment, read for
 * each key through the scope and agent-version pins the run's activities resolve
 * with, and written to `WorkflowRun.harnessProfileVersions`. Approving a newer
 * version, or disabling the profile, after the run starts cannot change what the
 * run's agents are given. Only OK profiles are pinned: a bound-but-disabled one
 * is left out so the run fails closed where the agent first uses it, rather than
 * freezing a profile an admin has already withdrawn. The same holds for a plugin
 * bound on an agent version that is not platform-wide when the run's team has not
 * enabled it: it is left out, so the agent fails closed where it first uses it.
 * A key whose resolution fails is left out too, and pins at first use.
 */
export async function snapshotHarnessProfileVersions(
  ctx: ResolveCtx
): Promise<Record<string, number>> {
  const keys = await visibleAgentKeys(ctx);
  const pinnable = new Set<string>();
  /** Plugin names bound on a version that needs the team's enablement, by team. */
  const gated = new Map<string, Set<string>>();
  await Promise.all(
    keys.map(async (key) => {
      try {
        const binding = await resolveAgentProfileBinding(key, ctx);
        if (binding.harnessProfiles.length === 0) {
          return;
        }
        if (!bindingNeedsEnablement(binding.scope)) {
          for (const name of binding.harnessProfiles) {
            pinnable.add(name);
          }
          return;
        }
        const teamId = enablementTeamId(ctx, binding);
        if (!teamId) {
          return;
        }
        const names = gated.get(teamId) ?? new Set<string>();
        for (const name of binding.harnessProfiles) {
          names.add(name);
        }
        gated.set(teamId, names);
      } catch {
        // Unresolvable now: it pins (or fails) where the run first uses it.
      }
    })
  );
  const wanted = new Set([...pinnable, ...[...gated.values()].flatMap((n) => [...n])]);
  if (wanted.size === 0) {
    return {};
  }
  const profiles = await prisma.harnessProfile.findMany({
    select: { id: true, latestVersion: true, name: true },
    where: { name: { in: [...wanted] }, status: 'OK' },
  });
  const allowed = new Set(pinnable);
  for (const [teamId, names] of gated) {
    const enabled = await enabledProfileIds(
      profiles.filter((p) => names.has(p.name)).map((p) => p.id),
      teamId
    );
    for (const p of profiles) {
      if (names.has(p.name) && enabled.has(p.id)) {
        allowed.add(p.name);
      }
    }
  }
  return Object.fromEntries(
    profiles.filter((p) => allowed.has(p.name)).map((p) => [p.name, p.latestVersion])
  );
}
