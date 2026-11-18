import type { CapabilityKey } from './catalog/index.js';

/**
 * Vocabulary of the permissions module. Type-only: nothing here reads a stored role value (that is
 * `standing.ts`'s job), so the abstract names below are the target names of the three role enums.
 */

/** Where a capability is exercised. */
export type CapabilityScope = 'platform' | 'org' | 'team';

/**
 * How far authority flows down containment (platform, organization, team).
 *
 *   governance  shapes who and what belongs to a team: team role, org `ADMIN`, platform `ADMIN`
 *   operation   does the team's work: team role, platform `ADMIN`. Org authority does not reach it
 *   sensitive   runs code or holds credentials: the capability's own team role, platform `ADMIN`
 *   read        reads state: any of the above, plus org members where the data is org-wide
 */
export type CapabilityClass = 'governance' | 'operation' | 'sensitive' | 'read';

/** A team role as the permissions module sees it, lowest first. */
export type TeamRank = 'MEMBER' | 'LEAD' | 'ADMIN';

/** An organization role as the permissions module sees it, lowest first. */
export type OrgRank = 'MEMBER' | 'ADMIN';

/** What the catalog states about one capability. */
export interface CapabilityDef {
  scope: CapabilityScope;
  class: CapabilityClass;
  /** Minimum team role that confers it. Omitted: a team role does not confer it. */
  team?: TeamRank;
  /**
   * Minimum organization role that confers it for the resource's organization. Omitted: no
   * organization role confers it. On a team-scoped capability it takes effect only for
   * `governance` and `read` (see `orgRuleApplies`).
   */
  org?: OrgRank;
  /** Whether platform `ADMIN` confers it. Default `true`. */
  platformAdmin?: boolean;
  /**
   * Whether the team must be active for a team or org role to confer it. Default: every class but
   * `read`. Platform `ADMIN` is never stopped by an inactive team.
   */
  requiresActiveTeam?: boolean;
  description: string;
}

/** A person, or a machine identity that is judged by its token scopes and never by `can()`. */
export type Actor = { kind: 'user'; id: string; role: string } | { kind: 'principal'; id: string };

/**
 * What a capability is asked about. A resource names one thing or several; with none, the question
 * is person-level (platform-scoped capabilities) or platform-admin only (team and org scoped).
 */
export type Resource =
  | { teamId: string }
  | { orgId: string }
  | { anyOf: readonly Resource[] }
  | { allOf: readonly Resource[] }
  | { anyTeam: true }
  | undefined;

/** The ground on which a decision was made, ordered in the doc from least to most exceptional. */
export type Authority = 'team-role' | 'org-member' | 'org-admin' | 'platform-admin';

export type Decision<K extends string = CapabilityKey> =
  | { allowed: true; authority: Authority }
  | {
      allowed: false;
      code: 'FORBIDDEN' | 'NOT_FOUND';
      reason: string;
      missing: K;
    };

/** One team as the loader found it, with the actor's place in it. */
export interface TeamStanding {
  teamId: string;
  isActive: boolean;
  orgId: string | null;
  /** The actor's membership, or `null` when they are not a member. */
  rank: TeamRank | null;
  /**
   * The membership row's stored role, opaque. Carried only so `request.teamRole` keeps the
   * spelling older code compares; nothing in this module reads it.
   */
  storedRole: string | null;
}

/** One organization and the actor's place in it. */
export interface OrgStanding {
  orgId: string;
  rank: OrgRank | null;
}

/** Everything `decide` needs, already loaded, so it is a pure function. */
export interface Standing {
  actor: Actor;
  /** Whether the actor holds platform `ADMIN`. Derived once, by `standing.ts`. */
  platformAdmin: boolean;
  /** Teams the resource names (and their standing). A team absent here does not exist. */
  teams: ReadonlyMap<string, TeamStanding>;
  /** Organizations the resource names, or that a named team belongs to. */
  orgs: ReadonlyMap<string, OrgStanding>;
  /** Every team the actor belongs to. Loaded only for an `{ anyTeam: true }` question. */
  memberships?: readonly TeamStanding[];
}

/** The set a list endpoint may filter by. */
export interface HeldScope {
  /** The actor holds the capability everywhere: apply no filter. */
  all: boolean;
  teamIds: string[];
  orgIds: string[];
}
