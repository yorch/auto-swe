/**
 * Whether GitHub has to agree before a user reaches a repository.
 *
 * Team membership decides which repositories a user may reach; this decides
 * whether the source-control host is consulted as a second condition. The two
 * are ANDed, never substituted: a permission row can only ever take access
 * away, so nobody reaches a repository whose team they do not belong to.
 *
 * The rollout dial is `repoAccess.mode`:
 *
 *   off       team membership alone, exactly as before this existed.
 *   advisory  every launch that WOULD be refused is logged and allowed.
 *   enforce   launches are refused and listings are filtered.
 *
 * **Advisory reports on launching, not on viewing.** A launch is one decision
 * and logging it costs nothing; reporting what a listing would have hidden
 * would mean running every listing twice, on every page render, for the whole
 * rollout. The launch log is the signal that tells an operator whether the
 * projection is populated and whether users have GitHub logins recorded — which
 * is what the advisory period is for.
 */

import { resolveSettings } from '../config/index.js';
import type { PrismaClient } from '../index.js';
import type { AccessActor, AccessLog } from './accessActor.js';
import { permissionMeets } from './githubPermission.js';
import { recordRepoPermission } from './repoAccessProjection.js';
import {
  lookupPermissionViaUserCredential,
  lookupRepoPermission,
  type PermissionRepo,
  verifiedGithubLoginFor,
} from './repoPermission.js';

export type RepoAccessMode = 'off' | 'advisory' | 'enforce';

export interface RepoAccessGate {
  mode: RepoAccessMode;
  /** How old a cached answer may be and still count, for listings. */
  staleAfterHours: number;
}

/**
 * Read the gate's configuration.
 *
 * Behind the setting registry's ~30s cache, so calling this per request is a
 * memory read in the steady state rather than a query.
 */
/**
 * The last gate this process successfully read.
 *
 * A config read that fails must not silently turn enforcement off. Defaulting
 * to `off` on a blip would allow launches that were being refused a second
 * earlier, which is the opposite of what §7 of the doc promises and is
 * invisible to the person it lets through. Reusing the last known-good value
 * keeps a deployment enforcing across a database hiccup, and a process that has
 * never read the config has nothing to enforce anyway.
 */
let lastKnownGate: RepoAccessGate | null = null;

/** Drop the remembered gate and any failure backoff. Exported for tests. */
export function resetRepoAccessGateCache(): void {
  lastKnownGate = null;
  lastFailedReadAt = 0;
}

export async function resolveRepoAccessGate(): Promise<RepoAccessGate> {
  const cfg = await resolveSettings(
    ['repoAccess.mode', 'repoAccess.syncEnabled', 'repoAccess.viewStaleAfterHours'],
    {}
  );
  const mode = cfg['repoAccess.mode'] as RepoAccessMode;
  warnIfEnforcingWithoutSync(mode, cfg['repoAccess.syncEnabled']);
  lastKnownGate = {
    mode,
    staleAfterHours: cfg['repoAccess.viewStaleAfterHours'],
  };
  return lastKnownGate;
}

/** So the warning below is a line an operator sees, not one per request. */
let warnedAboutMissingSweep = false;

/**
 * Enforcing with the sweep disabled is a configuration the settings cannot
 * forbid and an operator can reach by accident, because the two knobs default
 * opposite ways: `repoAccess.mode` is the one they came to change, and
 * `repoAccess.syncEnabled` is off.
 *
 * In that pairing every listing is filtered against a projection nothing
 * refreshes, and no stored GitHub login is ever re-verified — so a username
 * that changes hands is never detected. Enforcement looks like it is working
 * while half of it is not running.
 */
function warnIfEnforcingWithoutSync(mode: RepoAccessMode, syncEnabled: boolean): void {
  if (mode !== 'enforce' || syncEnabled || warnedAboutMissingSweep) {
    warnedAboutMissingSweep = mode === 'enforce' && !syncEnabled;
    return;
  }
  warnedAboutMissingSweep = true;
  console.warn(
    '[repoAccess] mode is `enforce` but `repoAccess.syncEnabled` is false. Listings are filtered against a projection nothing refreshes, and stored GitHub logins are never re-verified. Enable the sweep.'
  );
}

/**
 * How long a failed read suppresses the next attempt.
 *
 * The settings resolver caches successes, not failures, so without this every
 * authenticated request retries a store that is down — and each retry waits out
 * a connection timeout before falling back. That turns one unreachable
 * dependency into a slow response on every request in the process, which is a
 * worse outcome than the stale-config window this buys.
 *
 * Short enough that recovery is quick; long enough that a burst of requests
 * costs one attempt rather than one each.
 */
const FAILED_READ_BACKOFF_MS = 5_000;

/**
 * How long the gate read may take before the request stops waiting for it.
 *
 * This runs in `requireAuth`, on every authenticated request. A settings read is
 * a cached memory lookup in the steady state, so any real wait means the config
 * store is unreachable — and an unreachable dependency must not add its
 * connection timeout to every request in the process. Generous for the work
 * being done, short enough that nothing waits on it noticeably.
 */
const READ_TIMEOUT_MS = 2_000;

let lastFailedReadAt = 0;

/** A sentinel that is not a `RepoAccessGate`, so the race is unambiguous. */
const TIMED_OUT = Symbol('repoAccessGate.timeout');

function withTimeout(p: Promise<RepoAccessGate>): Promise<RepoAccessGate | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), READ_TIMEOUT_MS);
    // `unref` so a pending timer cannot hold the process open — this runs on
    // every request, and one that outlives its request must not keep the
    // gateway from shutting down.
    timer.unref?.();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Resolve the gate, falling back to the last value this process read rather
 * than to `off`. Returns null only when the config has never been readable.
 *
 * A recent failure short-circuits rather than retrying, so a config store that
 * is down cannot add its timeout to every request.
 */
export async function resolveRepoAccessGateOrLastKnown(): Promise<RepoAccessGate | null> {
  if (Date.now() - lastFailedReadAt < FAILED_READ_BACKOFF_MS) {
    return lastKnownGate;
  }
  try {
    const result = await withTimeout(resolveRepoAccessGate());
    if (result === TIMED_OUT) {
      lastFailedReadAt = Date.now();
      return lastKnownGate;
    }
    return result;
  } catch {
    lastFailedReadAt = Date.now();
    return lastKnownGate;
  }
}

/**
 * Which GitHub identity the launched run will act as.
 *
 * `'caller'` only on a path that records the caller as the run's launcher
 * (`RunRequest.launchedById`), so the run may use the caller's own saved token
 * and the gate judges that token. `'platform'` everywhere else — Slack,
 * schedules — where the run uses the platform credential whatever the caller
 * saved. The default is `'platform'`, the pre-existing login-based check, so a
 * call site that does not think about this keeps behaving as it always did.
 */
export type RunIdentity = 'caller' | 'platform';

/** The verdict a launch attempt produced. */
export type LaunchDecision =
  | { allowed: true; reason: 'gate-off' | 'admin' | 'permitted' | 'advisory-would-refuse' }
  | { allowed: false; reason: LaunchRefusal };

export type LaunchRefusal =
  | 'no-github-identity'
  | 'insufficient-permission'
  | 'lookup-unavailable'
  | 'host-mismatch'
  | 'user-credential-rejected';

/** Human-readable refusal text, for the API response. */
export const LAUNCH_REFUSAL_MESSAGE: Record<LaunchRefusal, string> = {
  // Distinct from `lookup-unavailable`: the repository's host is not the
  // instance's, so no platform credential applies and a retry cannot succeed.
  'host-mismatch':
    "The platform's GitHub credential cannot be used for this repository's host, so your access cannot be checked. An admin can set the GitHub integration's web and API URLs to that host, or you can save your own token for this repository on the Connections page.",
  'insufficient-permission': 'GitHub reports that you do not have write access to this repository.',
  'lookup-unavailable':
    'Your GitHub access to this repository could not be confirmed right now. Try again shortly.',
  'no-github-identity':
    'Link your GitHub account before starting a run — the platform has no GitHub identity to check against.',
  // Distinct from `lookup-unavailable`: retrying does not help, and the fix is
  // in the user's own hands rather than GitHub's.
  'user-credential-rejected':
    'GitHub rejected the token you saved for this repository, or it cannot see the repository. Replace or remove it on the Connections page.',
};

/**
 * Decide whether `user` may start a run against `repo`.
 *
 * The launch path is low-volume and high-stakes, so it asks GitHub live rather
 * than reading the projection. That makes the gate effectively real-time for
 * the decision that matters most, and the answer is written back so listings
 * benefit from it too.
 *
 * **Fails closed.** A lookup that cannot be made is not permission to proceed:
 * an unanswered question is not a yes. This is the same posture the runtime
 * scanners take, and the reason it is safe here is that the failure is loud,
 * immediate, and retryable by the person in front of it — unlike a listing,
 * where the equivalent would be silently emptying someone's dashboard.
 */
export async function decideRepoLaunch(
  prisma: PrismaClient,
  user: AccessActor,
  repo: PermissionRepo & { id: string },
  gate: RepoAccessGate,
  log?: AccessLog,
  runIdentity: RunIdentity = 'platform'
): Promise<LaunchDecision> {
  if (gate.mode === 'off') {
    return { allowed: true, reason: 'gate-off' };
  }
  // Platform ADMINs bypass, consistent with every other check in the gateway.
  if (user.role === 'ADMIN') {
    return { allowed: true, reason: 'admin' };
  }

  const refusal = await launchRefusal(prisma, user, repo, runIdentity);
  if (!refusal) {
    return { allowed: true, reason: 'permitted' };
  }

  if (gate.mode === 'advisory') {
    log?.warn(
      { connectionId: repo.id, refusal, userId: user.sub },
      'repoAccess advisory: this launch would be refused under enforcement'
    );
    return { allowed: true, reason: 'advisory-would-refuse' };
  }
  return { allowed: false, reason: refusal };
}

/** Null when the launch is permitted; otherwise why it is not. */
async function launchRefusal(
  prisma: PrismaClient,
  user: AccessActor,
  repo: PermissionRepo & { id: string },
  runIdentity: RunIdentity
): Promise<LaunchRefusal | null> {
  // When the run will act as the caller, a caller who saved their own token for
  // this repository runs as that token, so that is the identity whose access
  // decides — asked with the token itself, which needs no stored login.
  // Otherwise the run uses the platform credential whatever the caller saved,
  // and judging it by their token would both refuse for a token the run never
  // touches and admit someone on an identity the run does not act as.
  const viaCredential =
    runIdentity === 'caller'
      ? await lookupPermissionViaUserCredential(prisma, repo, user.sub)
      : null;
  if (viaCredential) {
    await recordRepoPermission(prisma, {
      connectionId: repo.id,
      lookup: viaCredential,
      userId: user.sub,
    });
    if (!viaCredential.ok) {
      // A 404 here is the token failing to see the repository — the user's run
      // would fail to clone for the same reason — so it is the credential's
      // problem, not GitHub's.
      return viaCredential.failure === 'credential-rejected' ||
        viaCredential.failure === 'repo-not-found'
        ? 'user-credential-rejected'
        : 'lookup-unavailable';
    }
    return permissionMeets(viaCredential.permission, 'write') ? null : 'insufficient-permission';
  }

  // Verified, not merely read. This is the highest-stakes moment the gate has,
  // and it is the same argument that justified asking GitHub live here rather
  // than reading the projection: one extra round-trip on a low-volume path.
  const login = await verifiedGithubLoginFor(prisma, user.sub);
  if (!login) {
    return 'no-github-identity';
  }
  const lookup = await lookupRepoPermission(repo, login);
  // Record it either way — `recordRepoPermission` writes nothing on a failure,
  // which is exactly the behaviour wanted here too.
  await recordRepoPermission(prisma, {
    connectionId: repo.id,
    lookup,
    userId: user.sub,
  });
  if (!lookup.ok) {
    return lookup.failure === 'host-mismatch' ? 'host-mismatch' : 'lookup-unavailable';
  }
  // Starting a run means pushing a branch and opening a pull request, so read
  // access is not enough.
  return permissionMeets(lookup.permission, 'write') ? null : 'insufficient-permission';
}
