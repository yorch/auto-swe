/**
 * Refreshing the cached GitHub permission answers.
 *
 * The gate has to answer "may this user see this repository" for a whole
 * listing, and GitHub's collaborator endpoint answers for exactly one user and
 * one repository. Asking inline would mean up to a few hundred calls to render
 * one page, so the answers are materialised here and the request path reads
 * rows.
 *
 * The candidate set is deliberately not "every user times every repository": a
 * permission row only matters where team membership already allows access, so
 * the sweep walks each repository's own team members. That keeps the cost
 * proportional to real reachability rather than to the size of the deployment.
 */
import { prisma } from '@auto-swe/shared/db';
import {
  GITHUB_ACCOUNT_API_URL,
  verifyGithubLoginOwnership,
} from '@auto-swe/shared/lib/githubIdentityCheck';
import { recordRepoPermission } from '@auto-swe/shared/lib/repoAccessProjection';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { log } from '@temporalio/activity';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { resolveGitHubToken } from '../lib/githubAuth.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';

export interface SyncRepoAccessInput {
  /** Restrict the sweep to one repository. Omitted, it walks every active one. */
  connectionId?: string;
  /** Restrict the sweep to one user, by platform user id. */
  userId?: string;
}

export interface SyncRepoAccessResult {
  /** (user, repository) pairs GitHub answered for. */
  refreshed: number;
  /** Pairs whose lookup could not be made — left at their previous answer. */
  failed: number;
  /** Users with no GitHub login recorded, so nobody to ask GitHub about. */
  unresolvedUsers: number;
  /** Repositories skipped because they are not a git repo or have no identity. */
  skippedRepos: number;
  /**
   * Users whose stored login turned out to name a different GitHub account and
   * was cleared. Non-zero means someone's recorded identity had been taken over
   * by a re-registered username, which is worth an operator's attention.
   */
  reassignedLogins: number;
  /**
   * Users whose stored login had no GitHub account behind it — an unlink whose
   * hook failed. Also cleared, but counted separately so a benign case does not
   * inflate the takeover number above.
   */
  unlinkedLogins: number;
}

/**
 * Walk the reachable (user, repository) pairs and record what GitHub says.
 *
 * A failed lookup writes nothing. The existing row keeps its previous answer
 * and its previous `checkedAt`, so it ages out through the staleness window
 * rather than being overwritten with a denial GitHub never made — the one thing
 * this projection must never do.
 */
export async function syncRepoAccess(
  input: SyncRepoAccessInput = {}
): Promise<SyncRepoAccessResult> {
  const tracer = new AgentTracer();
  const started = Date.now();
  const result: SyncRepoAccessResult = {
    failed: 0,
    reassignedLogins: 0,
    refreshed: 0,
    skippedRepos: 0,
    unlinkedLogins: 0,
    unresolvedUsers: 0,
  };

  try {
    // Deliberately every team's repositories: the sweep's whole job is to keep
    // the projection current across the deployment, and scoping it to a tenant
    // would mean some team's answers silently stopped refreshing.
    const repos = await runUnscoped(
      'the permission sweep spans every team by definition',
      ['Connection'],
      () =>
        prisma.connection.findMany({
          select: {
            githubApiUrl: true,
            githubUrl: true,
            id: true,
            installation: { select: { installationId: true } },
            organizationName: true,
            repoName: true,
            team: {
              select: {
                memberships: {
                  select: { user: { select: { githubLogin: true, id: true } } },
                  // A deactivated user cannot sign in, so an answer about them
                  // would be quota spent on a decision nobody can reach.
                  where: { user: { isActive: true } },
                },
              },
            },
          },
          where: {
            isActive: true,
            type: 'git_repo',
            ...(input.connectionId && { id: input.connectionId }),
            ...(input.userId && { team: { memberships: { some: { userId: input.userId } } } }),
          },
        })
    );

    // Confirm each stored login still names the account it was stored for,
    // once per user rather than once per pair — it is a fact about the user, so
    // asking per repository would multiply the cost by the number of repos for
    // no extra information.
    //
    // A login goes stale in a way that matters when GitHub releases a renamed
    // username and someone else re-registers it: the projection then asks
    // GitHub about a different person and records their access as this user's.
    // A plain rename is harmless, because GitHub redirects the old name to the
    // same account id.
    const ghConfig = await resolveGitHubConfig();
    const platformToken = await resolveGitHubToken(ghConfig).catch(() => null);
    if (!platformToken) {
      // Without a credential the ownership check degrades to an unauthenticated
      // `GET /users/…`, capped at 60 requests an hour — so on any real
      // deployment it rate-limits, every answer reads as `unverifiable`, and
      // nothing is ever cleared. That is a silent no-op of a security control,
      // which is worth a loud line: the two configurations that reach it are an
      // App with an empty singleton installation id, and an App-only deployment
      // with per-repository installations and no PAT.
      log.warn(
        'repo access sync: no usable GitHub credential; login-ownership verification will rate-limit and detect nothing. Configure a PAT or a singleton installation id.'
      );
    }
    const verified = new Map<string, boolean>();
    for (const repo of repos) {
      for (const { user } of repo.team.memberships) {
        if (!user.githubLogin || verified.has(user.id)) {
          continue;
        }
        // Honour the narrowing, like the permission pass below does. Without
        // this a sweep scoped to one user verified — and could clear — the
        // login of every member of every team that user belongs to, and spent a
        // GitHub call per member to do it.
        if (input.userId && user.id !== input.userId) {
          continue;
        }
        const ownership = await verifyGithubLoginOwnership(prisma, {
          // A fixed github.com base, not the repository's host and not the
          // instance's. The stored account id comes from better-auth's built-in
          // `github` provider, which always talks to github.com, while both of
          // the other two are admin-settable to a GitHub Enterprise base — and
          // asking Enterprise about a github.com account id compares different
          // id spaces, which reads as a mismatch and CLEARS a valid login.
          apiUrl: GITHUB_ACCOUNT_API_URL,
          login: user.githubLogin,
          token: platformToken,
          userId: user.id,
        });
        verified.set(user.id, ownership.status === 'ok' || ownership.status === 'unverifiable');
        if (ownership.status === 'unlinked') {
          // A login with no account behind it — an unlink whose hook failed.
          // Cleared, but not the takeover alarm below.
          result.unlinkedLogins++;
          log.info('repo access sync: cleared a GitHub login with no linked account behind it', {
            clearedLogin: ownership.clearedLogin,
            userId: user.id,
          });
        }
        if (ownership.status === 'reassigned') {
          result.reassignedLogins++;
          // Logged, not only traced. This activity runs from a Temporal
          // Schedule with no `WorkflowRun` row behind it, so `persistActivityTrace`
          // resolves no run id and drops every record it holds — a trace here
          // would reach nobody. This is the one place an operator learns that
          // someone's recorded GitHub identity was taken over.
          log.warn('repo access sync: cleared a GitHub login that now names a different account', {
            clearedLogin: ownership.clearedLogin,
            userId: user.id,
          });
        }
      }
    }

    for (const repo of repos) {
      if (!(repo.organizationName && repo.repoName)) {
        result.skippedRepos++;
        continue;
      }
      const repoRef = toRepoRef(repo);
      const provider = getScmProvider(repoRef);

      for (const membership of repo.team.memberships) {
        const { githubLogin, id: userId } = membership.user;
        if (input.userId && userId !== input.userId) {
          continue;
        }
        if (!githubLogin) {
          result.unresolvedUsers++;
          continue;
        }
        // Cleared just above: the login named someone else, so any answer about
        // it would be that person's access recorded as this user's.
        if (verified.get(userId) === false) {
          result.unresolvedUsers++;
          continue;
        }

        const lookup = await provider.repoPermission(repoRef, githubLogin);
        if (!lookup.ok) {
          result.failed++;
          log.warn('repo access sync: permission lookup failed; previous answer left in place', {
            connectionId: repo.id,
            failure: lookup.failure,
            userId,
          });
          continue;
        }

        await recordRepoPermission(prisma, { connectionId: repo.id, lookup, userId });
        result.refreshed++;
      }
    }

    log.info('repo access sync complete', {
      ...result,
      durationMs: Date.now() - started,
      repos: repos.length,
    });
    return result;
  } finally {
    // Kept for the day this activity runs inside a workflow that has a run row.
    // It is a no-op from the Schedule, which is why the lines above log.
    await persistActivityTrace(tracer, 'repoAccessSync');
  }
}
