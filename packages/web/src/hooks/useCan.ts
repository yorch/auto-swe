'use client';

import type { CapabilityKey } from '@auto-swe/shared/permissions/client';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  type CapabilityScope,
  grantableTeamRoles,
  holdsCapability,
  isPlatformAdminAnswer,
  mayHoldViaOrg,
  orgCanConfer,
  orgIdsHolding,
  teamEntry,
  teamIdsHolding,
} from '@/lib/capabilities';
import type { TeamRoleValue } from '@/lib/roleLabels';
import { useAuthStore } from '@/stores/authStore';
import {
  teamPermissionsQuery,
  useEffectivePermissions,
  useTeamPermissions,
} from './useEffectivePermissions';

/**
 * Whether the signed-in person is a platform administrator, as the server's answer says. False
 * until that answer has loaded, which hides a control rather than flashing one that would be
 * refused.
 */
export function usePlatformAdmin(): boolean {
  return isPlatformAdminAnswer(useEffectivePermissions().data);
}

/**
 * Whether the person holds `capability` (a key of the permission catalog) where it is asked:
 *
 * - `useCan('platform.users.manage')`: a platform capability;
 * - `useCan('team.repos.manage', { teamId })`: on that team. A person with no membership there
 *   (an organization admin) is described by a per-team `?teamId=` query, fetched only when an
 *   organization role can confer the capability;
 * - `useCan('org.budget.manage', { orgId })`: in that organization;
 * - without an id, a team or organization capability asks "on any team / in any organization".
 *
 * A platform administrator holds everything. Anything not yet known is `false`: the browser reads
 * what the server decided and never grants from a role. The server checks every request itself.
 */
export function useCan(capability: CapabilityKey, scope: CapabilityScope = {}): boolean {
  return useCanState(capability, scope).allowed;
}

/** What `useCanState` knows about one capability check. */
export interface CanState {
  /** The same answer `useCan` gives: false while anything is unknown. */
  allowed: boolean;
  /** The question is still being answered: the person's permissions or the narrowed per-team one. */
  pending: boolean;
  /**
   * The narrowed per-team answer failed for a reason other than "no standing" (a 403 is that, and
   * reads as `allowed: false`); null otherwise. Distinguishes "refused" from "could not be asked".
   */
  error: unknown;
  /** Asks the failed narrowed question again. */
  retry: () => void;
}

/**
 * `useCan` with what a page needs to tell "no" from "not yet" and "could not ask": a direct link
 * to a tab only an organization admin holds renders before the narrowed per-team answer arrives,
 * and a not-found page there would be wrong for as long as the request is in flight or failed.
 */
export function useCanState(capability: CapabilityKey, scope: CapabilityScope = {}): CanState {
  const { data: perms, isLoading } = useEffectivePermissions();
  const teamId = scope.teamId ?? null;
  const needsNarrowed =
    !!perms &&
    !!teamId &&
    capability.startsWith('team.') &&
    orgCanConfer(capability) &&
    !isPlatformAdminAnswer(perms) &&
    !teamEntry(perms, teamId) &&
    // An organization the person is not in confers nothing: skip the request that would 403.
    mayHoldViaOrg(perms, scope.orgId);
  const narrowed = useTeamPermissions(teamId, needsNarrowed);
  const failed = narrowed.isError && (narrowed.error as { status?: number } | null)?.status !== 403;
  return {
    allowed: holdsCapability(perms, capability, scope, narrowed.data),
    error: failed ? narrowed.error : null,
    pending: isLoading || (needsNarrowed && narrowed.isLoading),
    retry: () => void narrowed.refetch(),
  };
}

/**
 * `useCan` for a list: answers per team for every team in `teams`, with one narrowed request per
 * team the person is not a member of (and could hold authority on through its organization).
 */
export function useCanOnTeams(
  capability: CapabilityKey,
  teams: readonly { id: string; orgId?: string | null }[]
): (teamId: string | null | undefined) => boolean {
  const { data: perms } = useEffectivePermissions();
  const sub = useAuthStore((s) => s.user?.sub ?? null);
  const wanted = useMemo(
    () =>
      !perms ||
      isPlatformAdminAnswer(perms) ||
      !capability.startsWith('team.') ||
      !orgCanConfer(capability)
        ? []
        : [...new Map(teams.map((t) => [t.id, t])).values()].filter(
            (t) => !teamEntry(perms, t.id) && mayHoldViaOrg(perms, t.orgId)
          ),
    [perms, teams, capability]
  );
  const narrowed = useQueries({
    queries: wanted.map((t) => teamPermissionsQuery(sub, t.id)),
  });
  const answers = new Map(wanted.map((t, i) => [t.id, narrowed[i]?.data]));
  return (teamId: string | null | undefined) =>
    !!teamId && holdsCapability(perms, capability, { teamId }, answers.get(teamId));
}

/**
 * The teams the person is a member of on which they hold `capability`, as a set of ids; `null`
 * while the answer loads. A platform administrator holds it everywhere, so ask `usePlatformAdmin`
 * (or `useCan`) first where "every team" is the right answer.
 */
export function useTeamIdsCan(capability: CapabilityKey): ReadonlySet<string> | null {
  const { data: perms } = useEffectivePermissions();
  return useMemo(
    () => (perms ? new Set(teamIdsHolding(perms, capability)) : null),
    [perms, capability]
  );
}

/** The organizations in which the person holds `capability`; `null` while the answer loads. */
export function useOrgIdsCan(capability: CapabilityKey): ReadonlySet<string> | null {
  const { data: perms } = useEffectivePermissions();
  return useMemo(
    () => (perms ? new Set(orgIdsHolding(perms, capability)) : null),
    [perms, capability]
  );
}

/**
 * The team roles the person may give on a team, lowest first, up to their effective rank; empty
 * when they may not manage its members.
 */
export function useGrantableTeamRoles(teamId: string | null | undefined): TeamRoleValue[] {
  const { data: perms } = useEffectivePermissions();
  const canManage = useCan('team.members.manage', { teamId });
  const narrowed = useTeamPermissions(
    teamId,
    canManage && !!perms && !teamEntry(perms, teamId ?? '')
  );
  return useMemo(
    () => (canManage && teamId ? grantableTeamRoles(perms, teamId, narrowed.data) : []),
    [canManage, perms, teamId, narrowed.data]
  );
}

/**
 * `useCan` for a resource that may have no owning team: a team's own (a template, a repository)
 * is asked on that team, one with no team (a GLOBAL template) belongs to the platform, so only a
 * platform administrator holds anything over it.
 */
export function useCanOwned(
  capability: CapabilityKey,
  teamId: string | null | undefined,
  orgId?: string | null
): boolean {
  const platformAdmin = usePlatformAdmin();
  const onTeam = useCan(capability, { orgId, teamId });
  return teamId ? onTeam : platformAdmin;
}
