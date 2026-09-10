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
import type { RepoPermission } from '@auto-swe/shared/lib/githubPermission';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';

/** Prisma's enum spelling for a host permission level. */
const TO_ENUM = {
  admin: 'ADMIN',
  none: 'NONE',
  read: 'READ',
  write: 'WRITE',
} as const satisfies Record<RepoPermission, 'ADMIN' | 'NONE' | 'READ' | 'WRITE'>;

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
    refreshed: 0,
    skippedRepos: 0,
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

        const lookup = await provider.repoPermission(repoRef, githubLogin);
        if (!lookup.ok) {
          result.failed++;
          tracer.addActivityEvent({
            name: 'repo_access.lookup_failed',
            outputJson: { connectionId: repo.id, failure: lookup.failure, userId },
          });
          continue;
        }

        const permission = TO_ENUM[lookup.permission];
        // `upsert` is safe here: `repo_access` has a plain unique index on
        // (user_id, connection_id), not one of the partial per-scope indexes
        // that force findFirst-then-create elsewhere in this codebase.
        await prisma.repoAccess.upsert({
          create: { connectionId: repo.id, permission, userId },
          update: { checkedAt: new Date(), permission },
          where: { userId_connectionId: { connectionId: repo.id, userId } },
        });
        result.refreshed++;
      }
    }

    tracer.addActivityEvent({
      durationMs: Date.now() - started,
      name: 'repo_access.sync',
      outputJson: { ...result, repos: repos.length },
    });
    return result;
  } finally {
    await persistActivityTrace(tracer, 'repoAccessSync');
  }
}
