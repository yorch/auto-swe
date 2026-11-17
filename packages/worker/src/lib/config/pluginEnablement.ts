import { prisma } from '@auto-swe/shared/db';
import type { ResolvedAgent } from './agentResolver.js';
import type { ResolveCtx } from './types.js';

/**
 * Whether a plugin binding (or a plugin-projected skill reference) on an agent
 * version of `scope` must be enabled for the run's team. Only a TEAM-scoped
 * version is written by team admins and needs the team's enablement. GLOBAL,
 * ORGANIZATION, CHANNEL and WORKFLOW_TEMPLATE versions can be written only by a
 * platform ADMIN and need none.
 */
export function bindingNeedsEnablement(scope: ResolvedAgent['scope']): boolean {
  return scope === 'TEAM';
}

/** The team whose enablement a non-platform-wide binding is checked against. */
export function enablementTeamId(
  ctx: ResolveCtx | undefined,
  binding: Pick<ResolvedAgent, 'teamId'>
): string | undefined {
  return ctx?.teamId ?? binding.teamId ?? undefined;
}

/**
 * Reserved key in `WorkflowRun.harnessProfileVersions` naming the Temporal
 * execution the pin map was taken for. A workflow id can be started again once
 * its earlier execution closes, and the run row is created once; a map that
 * names another execution is that execution's snapshot, not this one's.
 */
export const PIN_EXECUTION_KEY = '__execution';

/**
 * One plugin's pin in `WorkflowRun.harnessProfileVersions`. A bare number is the
 * pinned version (what older code wrote, and what a platform-wide binding needs).
 * The object form adds `verified`: the agent keys whose non-platform-wide binding
 * of this plugin passed the team's enablement check when this run began (or at
 * its first use). The pin decides the VERSION; only a verified (agent, plugin)
 * binding is exempt from re-checking enablement, so removing a team's enablement
 * cannot be bypassed through a version another agent's binding pinned.
 */
export type HarnessPinEntry = number | { version: number; verified?: string[]; hooks?: boolean };

export interface ParsedPin {
  version: number;
  verified: ReadonlySet<string>;
  /**
   * The hook switch (`HarnessProfile.hooksEnabled`) as read when the run pinned the
   * plugin. Undefined for a pin written without it: the first use pins it.
   */
  hooks?: boolean;
}

/** A stored pin entry (either shape) parsed, or undefined when it is neither. */
export function parsePinEntry(value: unknown): ParsedPin | undefined {
  const asVersion = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
  const bare = asVersion(value);
  if (bare !== undefined) {
    return { verified: new Set(), version: bare };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const { version, verified, hooks } = value as {
      version?: unknown;
      verified?: unknown;
      hooks?: unknown;
    };
    const v = asVersion(version);
    if (v !== undefined) {
      return {
        ...(typeof hooks === 'boolean' ? { hooks } : {}),
        verified: new Set(
          Array.isArray(verified) ? verified.filter((k): k is string => typeof k === 'string') : []
        ),
        version: v,
      };
    }
  }
  return undefined;
}

/**
 * The execution a stored pin map belongs to: the id it names, else the row's
 * `temporalRunId` (a map written before the id was embedded), else null.
 */
export function pinMapOwner(
  map: unknown,
  rowTemporalRunId: string | null | undefined
): string | null {
  const embedded =
    map && typeof map === 'object' && !Array.isArray(map)
      ? (map as Record<string, unknown>)[PIN_EXECUTION_KEY]
      : undefined;
  return typeof embedded === 'string' && embedded ? embedded : (rowTemporalRunId ?? null);
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
