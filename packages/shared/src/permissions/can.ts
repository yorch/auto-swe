import { CATALOG, type CapabilityKey } from './catalog/index.js';
import { orgRankMeets, teamRankMeets } from './standing.js';
import type {
  Authority,
  CapabilityDef,
  Decision,
  OrgStanding,
  Resource,
  Standing,
  TeamRank,
  TeamStanding,
} from './types.js';

/**
 * The pure decision: already-loaded standing in, `Decision` out. No database, so every rule below
 * is unit-testable. `load.ts` loads the standing and calls this.
 */

/** Whether platform `ADMIN` confers the capability. Default `true`. */
export function platformAdminHolds(def: CapabilityDef): boolean {
  return def.platformAdmin !== false;
}

/** Whether the team must be active for a role to confer the capability. Default: not `read`. */
export function requiresActiveTeam(def: CapabilityDef): boolean {
  return def.requiresActiveTeam ?? def.class !== 'read';
}

/**
 * Whether an organization role can confer a team-scoped capability at all. Org authority reaches
 * `governance` and `read`; it never reaches `operation` or `sensitive`, whatever the definition
 * says, so a catalog slip cannot hand an org admin a team's code or credentials.
 */
export function orgRuleApplies(def: CapabilityDef): boolean {
  return (
    def.org !== undefined &&
    (def.scope !== 'team' || def.class === 'governance' || def.class === 'read')
  );
}

/** How exceptional an authority is. A combined decision reports the most exceptional one used. */
const AUTHORITY_ORDER: Readonly<Record<Authority, number>> = {
  'org-admin': 2,
  'org-member': 1,
  'platform-admin': 3,
  'team-role': 0,
};

type Denied = Extract<Decision, { allowed: false }>;

function allow(authority: Authority): Decision {
  return { allowed: true, authority };
}

function deny(missing: CapabilityKey, reason: string): Decision {
  return { allowed: false, code: 'FORBIDDEN', missing, reason };
}

function orgRank(standing: Standing, orgId: string | null): OrgStanding['rank'] {
  return orgId ? (standing.orgs.get(orgId)?.rank ?? null) : null;
}

/** The decision for one capability with an explicit definition. `decide` looks the key up. */
export function decideWith(
  standing: Standing,
  key: CapabilityKey,
  def: CapabilityDef,
  resource?: Resource
): Decision {
  if (standing.actor.kind === 'principal') {
    return deny(key, 'a service principal is judged by its token scopes, not by capabilities');
  }
  return evaluate(standing, key, def, resource);
}

/** The decision for `capability`, looked up in the catalog. */
export function decide(standing: Standing, capability: CapabilityKey, resource?: Resource) {
  const def: CapabilityDef = CATALOG[capability];
  return decideWith(standing, capability, def, resource);
}

function evaluate(
  standing: Standing,
  key: CapabilityKey,
  def: CapabilityDef,
  resource: Resource
): Decision {
  if (resource && 'anyOf' in resource) {
    const decisions = resource.anyOf.map((r) => evaluate(standing, key, def, r));
    const allowed = decisions.filter((d) => d.allowed);
    if (allowed.length > 0) {
      // Report the least exceptional way in: it is the honest account of why it was allowed.
      return allowed.reduce((best, d) =>
        d.allowed && best.allowed && AUTHORITY_ORDER[d.authority] < AUTHORITY_ORDER[best.authority]
          ? d
          : best
      );
    }
    // Every leg refused: the answer must not depend on the order the resources were listed in.
    const refusals = decisions.filter((d): d is Denied => !d.allowed);
    refusals.sort((a, b) => a.reason.localeCompare(b.reason));
    return refusals[0] ?? deny(key, 'no resource was named');
  }
  if (resource && 'allOf' in resource) {
    if (resource.allOf.length === 0) {
      return deny(key, 'no resource was named');
    }
    let worst: Authority = 'team-role';
    for (const r of resource.allOf) {
      const decision = evaluate(standing, key, def, r);
      if (!decision.allowed) {
        return decision;
      }
      if (AUTHORITY_ORDER[decision.authority] > AUTHORITY_ORDER[worst]) {
        worst = decision.authority;
      }
    }
    return allow(worst);
  }
  return evaluateLeaf(standing, key, def, resource);
}

function evaluateLeaf(
  standing: Standing,
  key: CapabilityKey,
  def: CapabilityDef,
  resource: Exclude<Resource, { anyOf: unknown } | { allOf: unknown }>
): Decision {
  const platformAdmin = standing.platformAdmin && platformAdminHolds(def);

  if (resource && 'anyTeam' in resource) {
    return evaluateAnyTeam(standing, key, def, platformAdmin);
  }

  switch (def.scope) {
    case 'platform': {
      if (platformAdmin) {
        return allow('platform-admin');
      }
      return deny(key, 'requires platform admin');
    }
    case 'org':
      return evaluateOrg(standing, key, def, resource, platformAdmin);
    case 'team':
      return evaluateTeam(standing, key, def, resource, platformAdmin);
  }
}

function evaluateAnyTeam(
  standing: Standing,
  key: CapabilityKey,
  def: CapabilityDef,
  platformAdmin: boolean
): Decision {
  const needActive = requiresActiveTeam(def);
  if (def.team && def.scope !== 'org') {
    const held = (standing.memberships ?? []).some(
      (m) => (!needActive || m.isActive) && teamRankMeets(m.rank, def.team as TeamRank)
    );
    if (held) {
      return allow('team-role');
    }
  }
  // Org authority counts as the resolver counts it for one team: only where the class lets it
  // reach, and, for a team-scoped capability, only if the organization has a team it may act on.
  if (def.org && (def.scope === 'org' || orgRuleApplies(def))) {
    let member = false;
    for (const org of standing.orgs.values()) {
      if (!orgRankMeets(org.rank, def.org)) {
        continue;
      }
      const reaches =
        def.scope === 'org' ||
        (standing.orgTeams ?? []).some((t) => t.orgId === org.orgId && (!needActive || t.isActive));
      if (!reaches) {
        continue;
      }
      if (org.rank === 'ADMIN') {
        return allow('org-admin');
      }
      member = true;
    }
    if (member) {
      return allow('org-member');
    }
  }
  return platformAdmin ? allow('platform-admin') : deny(key, requirement(def));
}

function evaluateOrg(
  standing: Standing,
  key: CapabilityKey,
  def: CapabilityDef,
  resource: Exclude<Resource, { anyOf: unknown } | { allOf: unknown } | { anyTeam: true }>,
  platformAdmin: boolean
): Decision {
  let orgId: string | null = null;
  if (resource && 'orgId' in resource) {
    orgId = resource.orgId;
  } else if (resource && 'teamId' in resource) {
    // An unknown team is refused as a non-member of a real one would be: no existence oracle.
    orgId = standing.teams.get(resource.teamId)?.orgId ?? null;
  }
  const rank = orgRank(standing, orgId);
  if (def.org && orgRankMeets(rank, def.org)) {
    return allow(rank === 'ADMIN' ? 'org-admin' : 'org-member');
  }
  if (platformAdmin) {
    return allow('platform-admin');
  }
  return deny(
    key,
    resource
      ? `requires ${def.org ?? 'platform admin'} in this organization`
      : 'requires platform admin'
  );
}

function evaluateTeam(
  standing: Standing,
  key: CapabilityKey,
  def: CapabilityDef,
  resource: Exclude<Resource, { anyOf: unknown } | { allOf: unknown } | { anyTeam: true }>,
  platformAdmin: boolean
): Decision {
  if (!resource || !('teamId' in resource)) {
    // A team capability asked with no team (a global template, say): the operator's alone.
    return platformAdmin ? allow('platform-admin') : deny(key, 'requires platform admin');
  }
  const team: TeamStanding | undefined = standing.teams.get(resource.teamId);
  if (!team) {
    // Same refusal as a non-member of a real team gets, so the answer does not reveal whether the
    // team exists. Platform admin passes and the handler answers 404.
    return platformAdmin ? allow('platform-admin') : deny(key, requirement(def));
  }
  const activeOk = !requiresActiveTeam(def) || team.isActive;
  if (activeOk) {
    const orgRankHeld = orgRuleApplies(def) ? orgRank(standing, team.orgId) : null;
    const orgOk =
      def.org !== undefined && orgRuleApplies(def) && orgRankMeets(orgRankHeld, def.org);
    // An org admin acts as one whatever team role they also hold: membership never narrows it.
    if (orgOk && orgRankHeld === 'ADMIN') {
      return allow('org-admin');
    }
    if (def.team && teamRankMeets(team.rank, def.team)) {
      return allow('team-role');
    }
    if (orgOk) {
      return allow('org-member');
    }
  }
  if (platformAdmin) {
    return allow('platform-admin');
  }
  // Only someone with standing in the team (or its organization) is told it is deactivated.
  const hasStanding = team.rank !== null || orgRank(standing, team.orgId) !== null;
  return deny(key, !activeOk && hasStanding ? 'the team is deactivated' : requirement(def));
}

function requirement(def: CapabilityDef): string {
  const parts: string[] = [];
  if (def.team) {
    parts.push(`${def.team} in this team`);
  }
  if (def.org) {
    parts.push(`${def.org} in the team's organization`);
  }
  return parts.length ? `requires ${parts.join(' or ')}` : 'requires platform admin';
}

/**
 * The team rank the actor acts at for a member change in `teamId`, computed from standing alone
 * and per team: platform `ADMIN` ranks `ADMIN`; an organization `ADMIN` of that active team's own
 * organization ranks `ADMIN`; otherwise the membership's rank, or `null` for none. It does not
 * read a decision's authority, so a check on another team cannot change it.
 */
export function actingRank(standing: Standing, teamId: string): TeamRank | null {
  if (standing.platformAdmin) {
    return 'ADMIN';
  }
  const team = standing.teams.get(teamId);
  if (!team) {
    return null;
  }
  if (team.isActive && orgRank(standing, team.orgId) === 'ADMIN') {
    return 'ADMIN';
  }
  return team.rank;
}
