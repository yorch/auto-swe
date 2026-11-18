import { resolveSettings } from '@auto-swe/shared/config';
import { agentRunGrantsWriteTools, isLaunchableAgentKey } from '@auto-swe/shared/lib/agentRun';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance } from 'fastify';
import { agentScopeBranches, splitRef } from './agentRunLaunch.js';

/**
 * The allowlist a launch applies when the launcher names none: the `orchestration.defaultAllowlist`
 * setting at the named team's organization (then GLOBAL), reduced to the agents that are launchable
 * and currently active at GLOBAL or that organization's scope, in the setting's order.
 *
 * The setting is curated by an operator, so it can name an agent that was since deleted or
 * deactivated; filtering here means a stale entry shrinks the default instead of failing the launch.
 * An empty answer is the caller's to refuse (`ALLOWLIST_REQUIRED`).
 */
export async function resolveDefaultAllowlist(
  prisma: FastifyInstance['prisma'],
  ctx: { orgId: string; teamId?: string }
): Promise<string[]> {
  return (await resolveDefaults(prisma, ctx)).allowlist;
}

/** One agent row as the launch reads it: enough to pick the effective one for a reference. */
export type AllowlistAgentRow = {
  key: string;
  scope: string;
  toolKeys: unknown;
  version: number;
};

/**
 * The references from `refs` whose EFFECTIVE agent can change files, in `refs` order. The
 * effective agent is the one a spawn resolves: an organization override shadows the GLOBAL agent
 * of the same key (so an override of a read-only default can make it write-capable), and a
 * `key@version` pin selects that GLOBAL version. Write-capable is the worker's own definition
 * for agent runs (`writeFile` or `bash` named in `toolKeys`; `null` grants the read tools only).
 */
export function writeCapableRefs(refs: readonly string[], rows: readonly AllowlistAgentRow[]) {
  const latest = (list: readonly AllowlistAgentRow[]) =>
    list.reduce<AllowlistAgentRow | undefined>(
      (best, row) => (!best || row.version > best.version ? row : best),
      undefined
    );
  return refs.filter((ref) => {
    const { key, version } = splitRef(ref);
    const mine = rows.filter((r) => r.key === key);
    const effective =
      version !== undefined
        ? mine.find((r) => r.scope === 'GLOBAL' && r.version === version)
        : (latest(mine.filter((r) => r.scope === 'ORGANIZATION')) ??
          latest(mine.filter((r) => r.scope === 'GLOBAL')));
    return agentRunGrantsWriteTools(effective?.toolKeys);
  });
}

/** The default allowlist (see above) and which of its agents can change files as resolved now. */
export async function resolveDefaults(
  prisma: FastifyInstance['prisma'],
  ctx: { orgId: string; teamId?: string }
): Promise<{ allowlist: string[]; writeCapable: string[] }> {
  const settings = await resolveSettings(['orchestration.defaultAllowlist'], ctx);
  const configured = [...new Set(settings['orchestration.defaultAllowlist'] ?? [])].filter(
    isLaunchableAgentKey
  );
  if (configured.length === 0) {
    return { allowlist: [], writeCapable: [] };
  }
  const rows = await runUnscoped(
    'an agent run resolves its agent at GLOBAL and ORGANIZATION scope only',
    ['Agent'],
    () =>
      prisma.agent.findMany({
        select: { key: true, scope: true, toolKeys: true, version: true },
        where: { isActive: true, key: { in: configured }, OR: agentScopeBranches(ctx.orgId) },
      })
  );
  const present = new Set(rows.map((r) => r.key));
  const allowlist = configured.filter((key) => present.has(key));
  return {
    allowlist,
    writeCapable: writeCapableRefs(allowlist, rows),
  };
}
