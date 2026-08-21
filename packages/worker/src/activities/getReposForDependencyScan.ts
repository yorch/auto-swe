import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

export interface RepoForDependencyScan {
  repoId: string;
}

/**
 * Returns all active git_repo connections for the scheduled repo dependency
 * scan. Mirrors `getReposForConsolidation` — a deployment-wide sweep, so it
 * runs outside the tenant guard rather than filtering by team/org. Unlike
 * consolidation there is no per-repo opt-in column; every active git_repo is
 * scanned, and `detectRepoDependencies` is itself a no-op (skips gracefully)
 * for anything that isn't an active git_repo connection.
 */
export async function getReposForDependencyScan(): Promise<RepoForDependencyScan[]> {
  const repos = await runUnscoped(
    'the dependency scan schedule is deployment-wide; every active git_repo is a candidate',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: { id: true },
        where: { isActive: true, type: 'git_repo' },
      })
  );
  return repos.map((r) => ({ repoId: r.id }));
}
