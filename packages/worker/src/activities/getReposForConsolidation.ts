import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

export interface RepoForConsolidation {
  repoId: string;
}

/** Returns all active repos that have opted in to scheduled lesson consolidation. */
export async function getReposForConsolidation(): Promise<RepoForConsolidation[]> {
  const repos = await runUnscoped(
    'the consolidation schedule is deployment-wide; opt-in is the per-repo filter',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: { id: true },
        where: { consolidationEnabled: true, isActive: true },
      })
  );
  return repos.map((r) => ({ repoId: r.id }));
}
