import { prisma } from '@auto-swe/shared/db';
import type { ResolvedAgent } from './agentResolver.js';
import type { ResolveCtx } from './types.js';

/**
 * Whether a plugin binding on an agent version of `scope` must be enabled for the
 * run's team. Platform-wide (GLOBAL) bindings are set by an ADMIN and need no
 * enablement; every narrower version is a team-side decision and does.
 */
export function bindingNeedsEnablement(scope: ResolvedAgent['scope']): boolean {
  return scope !== 'GLOBAL';
}

/** The team whose enablement a non-platform-wide binding is checked against. */
export function enablementTeamId(
  ctx: ResolveCtx | undefined,
  binding: Pick<ResolvedAgent, 'teamId'>
): string | undefined {
  return ctx?.teamId ?? binding.teamId ?? undefined;
}

/** The ids of `profileIds` that `teamId` has enabled. */
export async function enabledProfileIds(
  profileIds: readonly string[],
  teamId: string
): Promise<Set<string>> {
  if (profileIds.length === 0) {
    return new Set();
  }
  const rows = await prisma.pluginEnablement.findMany({
    select: { profileId: true },
    where: { profileId: { in: [...profileIds] }, teamId },
  });
  return new Set(rows.map((r) => r.profileId));
}
