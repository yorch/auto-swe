/**
 * A test double for the three reads `can()` and `heldScope()` make through `PermissionsDb`
 * (`team.findMany`, `teamMembership.findMany`, `organizationMembership.findMany`), driven by a plain
 * description of the caller's standing instead of mocked Prisma rows.
 *
 * Wrap the mock Prisma object with `withStanding(mock, state)` before decorating the app. A
 * resolver read is answered from `state`; every other call goes to the original mock, so a test's
 * own `team.findMany` expectations and call counts are untouched.
 */

export interface TeamStandingState {
  /** The caller's stored team role, or null for a non-member. */
  role?: string | null;
  isActive?: boolean;
  orgId?: string | null;
}

export interface StandingState {
  teams: Record<string, TeamStandingState>;
  /** The caller's stored role in each organization. */
  orgs: Record<string, string>;
  /** A team no entry names: every team id the resolver asks about is this one. */
  fallback?: TeamStandingState;
}

export function emptyStanding(): StandingState {
  return { orgs: {}, teams: {} };
}

/** Reset `state` in place, so a wrapper built once keeps reading it. */
export function resetStanding(state: StandingState): void {
  state.teams = {};
  state.orgs = {};
  state.fallback = undefined;
}

/** Describe the caller's membership of one team. */
export function setTeam(
  state: StandingState,
  teamId: string,
  standing: TeamStandingState = {}
): void {
  state.teams[teamId] = { isActive: true, orgId: null, role: null, ...standing };
}

type Args = {
  select?: Record<string, unknown>;
  where?: { id?: { in?: string[] }; teamId?: { in?: string[] }; orgId?: { in?: string[] } };
} & Record<string, unknown>;

function inList(value: unknown): string[] | undefined {
  return (value as { in?: string[] } | undefined)?.in;
}

function entry(state: StandingState, id: string): TeamStandingState | undefined {
  return (
    state.teams[id] ??
    (state.fallback ? { isActive: true, orgId: null, ...state.fallback } : undefined)
  );
}

export function withStanding<T extends object>(prisma: T, state: StandingState): T {
  const db = prisma as Record<string, Record<string, (...a: unknown[]) => unknown>>;
  const wrap = (
    model: string,
    answer: (args: Args) => unknown[] | undefined
  ): Record<string, unknown> =>
    new Proxy((db[model] ?? {}) as object, {
      get(target, prop, receiver) {
        if (prop === 'findMany') {
          return (...a: unknown[]) => {
            const answered = answer((a[0] ?? {}) as Args);
            return answered === undefined
              ? (target as Record<string, (...x: unknown[]) => unknown>).findMany(...a)
              : Promise.resolve(answered);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Record<string, unknown>;

  const team = wrap('team', (args) => {
    const sel = args.select ?? {};
    const ids = inList(args.where?.id);
    if (sel.id && sel.isActive && sel.orgId && ids) {
      return ids
        .filter((id) => entry(state, id))
        .map((id) => ({
          id,
          isActive: entry(state, id)?.isActive ?? true,
          orgId: entry(state, id)?.orgId ?? null,
        }));
    }
    const orgIds = inList(args.where?.orgId);
    if (orgIds && sel.id && !sel.isActive) {
      return Object.entries(state.teams)
        .filter(([, t]) => t.orgId && orgIds.includes(t.orgId))
        .filter(([, t]) => (t.isActive ?? true) || !(args.where as { isActive?: boolean }).isActive)
        .map(([id]) => ({ id }));
    }
    if (orgIds && sel.isActive && sel.orgId && !sel.id) {
      return Object.values(state.teams)
        .filter((t) => t.orgId && orgIds.includes(t.orgId))
        .map((t) => ({ isActive: t.isActive ?? true, orgId: t.orgId }));
    }
    return undefined;
  });

  const teamMembership = wrap('teamMembership', (args) => {
    const sel = args.select ?? {};
    const ids = inList(args.where?.teamId);
    if (sel.role && sel.teamId && ids) {
      return ids
        .filter((id) => entry(state, id)?.role)
        .map((id) => ({ role: entry(state, id)?.role, teamId: id }));
    }
    if (sel.role && sel.team) {
      return Object.entries(state.teams)
        .filter(([, t]) => t.role)
        .map(([id, t]) => ({
          role: t.role,
          team: { id, isActive: t.isActive ?? true, orgId: t.orgId ?? null },
        }));
    }
    return undefined;
  });

  const organizationMembership = wrap('organizationMembership', (args) => {
    const sel = args.select ?? {};
    if (sel.orgId && sel.role) {
      const ids = inList(args.where?.orgId);
      return Object.entries(state.orgs)
        .filter(([orgId]) => !ids || ids.includes(orgId))
        .map(([orgId, role]) => ({ orgId, role }));
    }
    return undefined;
  });

  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === 'team') {
        return team;
      }
      if (prop === 'teamMembership') {
        return teamMembership;
      }
      if (prop === 'organizationMembership') {
        return organizationMembership;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
