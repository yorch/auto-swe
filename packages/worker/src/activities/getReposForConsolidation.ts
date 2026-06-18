import { prisma } from '@auto-swe/shared/db';

export interface RepoForConsolidation {
  repoId: string;
}

/** Returns all active repos that have opted in to scheduled lesson consolidation. */
export async function getReposForConsolidation(): Promise<RepoForConsolidation[]> {
  const repos = await prisma.connection.findMany({
    select: { id: true },
    where: { consolidationEnabled: true, isActive: true },
  });
  return repos.map((r) => ({ repoId: r.id }));
}
