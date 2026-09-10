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
import type { PrismaClient } from '@auto-swe/shared';
import { resolveSettings } from '@auto-swe/shared/config';
import { permissionMeets } from '@auto-swe/shared/lib/githubPermission';
import { recordRepoPermission } from '@auto-swe/shared/lib/repoAccessProjection';
import type { FastifyBaseLogger } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import { githubLoginFor, lookupRepoPermission, type PermissionRepo } from './repoPermission.js';

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
export async function resolveRepoAccessGate(): Promise<RepoAccessGate> {
  const cfg = await resolveSettings(['repoAccess.mode', 'repoAccess.viewStaleAfterHours'], {});
  return {
    mode: cfg['repoAccess.mode'] as RepoAccessMode,
    staleAfterHours: cfg['repoAccess.viewStaleAfterHours'],
  };
}

/** The verdict a launch attempt produced. */
export type LaunchDecision =
  | { allowed: true; reason: 'gate-off' | 'admin' | 'permitted' | 'advisory-would-refuse' }
  | { allowed: false; reason: LaunchRefusal };

export type LaunchRefusal = 'no-github-identity' | 'insufficient-permission' | 'lookup-unavailable';

/** Human-readable refusal text, for the API response. */
export const LAUNCH_REFUSAL_MESSAGE: Record<LaunchRefusal, string> = {
  'insufficient-permission': 'GitHub reports that you do not have write access to this repository.',
  'lookup-unavailable':
    'Your GitHub access to this repository could not be confirmed right now. Try again shortly.',
  'no-github-identity':
    'Link your GitHub account before starting a run — the platform has no GitHub identity to check against.',
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
  user: JwtPayload,
  repo: PermissionRepo & { id: string },
  gate: RepoAccessGate,
  log?: FastifyBaseLogger
): Promise<LaunchDecision> {
  if (gate.mode === 'off') {
    return { allowed: true, reason: 'gate-off' };
  }
  // Platform ADMINs bypass, consistent with every other check in the gateway.
  if (user.role === 'ADMIN') {
    return { allowed: true, reason: 'admin' };
  }

  const refusal = await launchRefusal(prisma, user, repo);
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
  user: JwtPayload,
  repo: PermissionRepo & { id: string }
): Promise<LaunchRefusal | null> {
  const login = await githubLoginFor(prisma, user.sub);
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
    return 'lookup-unavailable';
  }
  // Starting a run means pushing a branch and opening a pull request, so read
  // access is not enough.
  return permissionMeets(lookup.permission, 'write') ? null : 'insufficient-permission';
}
