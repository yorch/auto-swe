/**
 * One decision for "may this user act on this repository".
 *
 * Every launch path used to make that decision twice: a hand-written
 * `repo.team.memberships.length === 0` test, and then — where someone
 * remembered — a call to the GitHub gate. Two checks at seven call sites is
 * fourteen chances to omit one, and the omissions were not hypothetical: the
 * Slack modal, the human-step resolver, epics, PRD runs, template runs and both
 * scheduled-work-request paths each shipped with the membership half and
 * without the gate, and each was found by a different reviewer.
 *
 * Folding the membership test into the same function removes the class. A call
 * site cannot check membership without also asking the gate, because there is
 * no longer a way to express one without the other.
 *
 * **Why this is not a `where` predicate.** The routes deliberately load the
 * repository first and decide afterwards, so a refusal can name the
 * repositories the caller cannot reach — an epic naming five repos says which
 * two were denied. Filtering in the query would turn every one of those into
 * "no such repository", which is a worse answer to a legitimate mistake. The
 * predicate form (`reachableConnections`) remains right for listings, where
 * there is nothing to name.
 */

import type { PrismaClient } from '../index.js';
import type { AccessActor, AccessLog } from './accessActor.js';
import {
  decideRepoLaunch,
  LAUNCH_REFUSAL_MESSAGE,
  type LaunchRefusal,
  type RepoAccessGate,
} from './repoAccessGate.js';

/**
 * Everything a decision reads, with nothing optional.
 *
 * Required rather than optional on purpose, and it is the second half of what
 * makes omission impossible: a call site that forgets to select the memberships,
 * the installation, or `githubApiUrl` fails to compile. Each omission is
 * otherwise silent — no memberships reads as "not a member", a missing
 * installation asks the wrong GitHub account, and a missing `githubApiUrl` asks
 * github.com about a repository that lives on GitHub Enterprise and then caches
 * the answer.
 */
export interface RepoAccessSubject {
  id: string;
  /** `git_repo`, `mcp`, `http_api`, and friends — see `connectionTypes.ts`. */
  type: string;
  organizationName: string | null;
  repoName: string | null;
  githubApiUrl: string | null;
  installation: { installationId: string; isActive: boolean } | null;
  /** Must be filtered to the acting user, or pre-filtered by the query. */
  team: { memberships: Array<{ userId: string }> };
}

export type RepoAccessRefusal = 'not-a-team-member' | 'installation-retired' | LaunchRefusal;

export type RepoAccessVerdict =
  | { allowed: true; reason: 'admin' | 'gate-off' | 'permitted' | 'advisory-would-refuse' }
  | { allowed: false; reason: RepoAccessRefusal };

/** Human-readable refusal text, for the API response. */
export const REPO_ACCESS_REFUSAL_MESSAGE: Record<RepoAccessRefusal, string> = {
  ...LAUNCH_REFUSAL_MESSAGE,
  'installation-retired':
    'The GitHub App installation this repository uses has been retired. An admin has to point it at a current installation before new work can start here.',
  'not-a-team-member': 'You do not have access to this repository.',
};

/**
 * Has the installation this repository reaches been retired?
 *
 * Separate from {@link decideRepoAccess} because it takes no user: retirement
 * is a statement about the platform's configuration, not about who is asking.
 * The launch paths that have no authenticated user — the template webhook and
 * the issue-tracker auto-trigger — are exempt from the GitHub gate for want of
 * an identity, and that exemption must not carry them past this too.
 *
 * A retired installation stops NEW work and nothing else. Clones, pushes, CI
 * reads and runs already under way keep resolving credentials through it, so
 * retiring one cannot break work in flight — an operator marking a row
 * decommissioned is stating an intention about what starts next, not pulling a
 * cable. That is why this is consulted at the decision, not in the token
 * resolver every one of those paths shares.
 */
export function isInstallationRetired(repo: {
  installation?: { isActive: boolean } | null;
}): boolean {
  // Optional chaining, not `!== null`. A relation that was not selected arrives
  // as `undefined`, and `undefined !== null` is true — so the stricter-looking
  // comparison read a missing installation as a retired one and then threw
  // reading `.isActive` off it. The type requires the field at every production
  // call site, which is exactly why nothing caught this until a test fixture
  // left it out.
  return repo.installation?.isActive === false;
}

/** The error body for a refusal that has no user to describe. */
export function installationRetiredErrorBody(): {
  error: { code: string; message: string; reason: string };
} {
  return repoAccessErrorBody('installation-retired');
}

/**
 * May `user` start a run against `repo`?
 *
 * Team membership first, then GitHub. The order matters for what a refusal
 * says: someone outside the team is told exactly that, rather than being sent
 * to link a GitHub account that would not help them.
 *
 * The two conditions are ANDed. GitHub can only ever take access away, so
 * membership stays the outer bound however the gate is configured — including
 * when it is off, which is why the membership test is not inside the gate's
 * own mode switch.
 */
export async function decideRepoAccess(
  prisma: PrismaClient,
  user: AccessActor,
  repo: RepoAccessSubject,
  gate: RepoAccessGate,
  log?: AccessLog
): Promise<RepoAccessVerdict> {
  // Membership first, and only for non-admins. Someone outside the team gets
  // the answer that is actionable for them, rather than being told about an
  // installation they have no stake in.
  if (user.role !== 'ADMIN' && !repo.team.memberships.some((m) => m.userId === user.sub)) {
    return { allowed: false, reason: 'not-a-team-member' };
  }
  // Then the installation, for EVERYONE — admins included, and ahead of the
  // no-coordinates exemption below.
  //
  // Retirement is operator configuration, not a statement about the person
  // asking, so neither the admin bypass nor an identity-shaped exemption should
  // skip it. An admin who retired an installation and then launched through it
  // anyway would get GitHub's failure instead of ours, which is a worse way to
  // learn the same thing.
  if (isInstallationRetired(repo)) {
    return { allowed: false, reason: 'installation-retired' };
  }
  if (user.role === 'ADMIN') {
    return { allowed: true, reason: 'admin' };
  }
  // Exempt only a row with no repository to ask about. An MCP server or an
  // HTTP API is a `Connection` too, and asking GitHub about one answers
  // `repo-not-found`, which fails closed — so without this a template run
  // against an `api_only` connection would be refused for a reason that cannot
  // apply to it.
  //
  // Keyed on the coordinates, not on `type`, because those are what the
  // justification is actually about. The repository routes require org/repo
  // only for `git_repo` rows and de-duplicate only within them, so a team LEAD
  // can create an `http_api` or `notion` row carrying the coordinates of a
  // repository they have no access to — including one already onboarded. Keyed
  // on `type`, such a row would skip a gate that has something real to check.
  if (!(repo.organizationName && repo.repoName)) {
    return { allowed: true, reason: 'permitted' };
  }
  return decideRepoLaunch(prisma, user, repo, gate, log);
}

/**
 * The error body for a route that decided about several repositories at once.
 *
 * Names every refusal rather than the first, so a caller naming five
 * repositories fixes them in one pass instead of five.
 *
 * The code stays `FORBIDDEN` while every refusal is a plain membership one.
 * That is the answer these routes gave before the GitHub gate existed, and a
 * client handling it should not start seeing a new code for a case whose
 * meaning has not changed. `REPO_ACCESS_DENIED` appears only when at least one
 * refusal is genuinely new.
 */
export function multiRepoRefusalBody(
  refusals: Array<{ label: string; reason: RepoAccessRefusal }>
): {
  error: {
    code: string;
    message: string;
    reasons: Array<{ repo: string; reason: RepoAccessRefusal }>;
  };
} {
  // `FORBIDDEN` whenever ANY refusal is a membership one, not only when every
  // one is. Before the gate existed, these routes ran the membership check to
  // completion and answered `FORBIDDEN` if any named repository failed it,
  // whatever else was wrong — so a caller who is not a member of one repository
  // and lacks GitHub write on another saw `FORBIDDEN` then and must see it now.
  // Requiring unanimity would change the code for a case whose membership half
  // has not changed meaning.
  const anyMembership = refusals.some((r) => r.reason === 'not-a-team-member');
  // A retired installation keeps its own code here too. Collapsing it into
  // `REPO_ACCESS_DENIED` on the multi-repo routes would be the exact conflation
  // the single-repo helper exists to avoid: one is operator configuration, the
  // other is a statement about this user. Membership still wins when both are
  // present, because that is the answer these routes gave before any of this.
  const anyRetired = refusals.some((r) => r.reason === 'installation-retired');
  return {
    error: {
      code: anyMembership
        ? 'FORBIDDEN'
        : anyRetired
          ? 'INSTALLATION_RETIRED'
          : 'REPO_ACCESS_DENIED',
      message: `You cannot start work on: ${refusals
        .map((r) => `${r.label}: ${REPO_ACCESS_REFUSAL_MESSAGE[r.reason]}`)
        .join('; ')}`,
      // The machine-readable reasons, which a concatenated English message
      // loses. The single-repo helper emits `reason`; without this the two
      // shapes would disagree about whether a client can tell "link your GitHub
      // account" from "insufficient permission".
      reasons: refusals.map((r) => ({ reason: r.reason, repo: r.label })),
    },
  };
}

/** The error body a refused decision should produce. */
export function repoAccessErrorBody(refusal: RepoAccessRefusal): {
  error: { code: string; message: string; reason: string };
} {
  return {
    error: {
      // A team-membership refusal keeps the code every client already handles;
      // only the GitHub-gate refusals are new.
      code:
        refusal === 'not-a-team-member'
          ? 'FORBIDDEN'
          : refusal === 'installation-retired'
            ? 'INSTALLATION_RETIRED'
            : 'REPO_ACCESS_DENIED',
      message: REPO_ACCESS_REFUSAL_MESSAGE[refusal],
      reason: refusal,
    },
  };
}
