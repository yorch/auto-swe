import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { indexKnowledgeBaseSnapshot as buildSnapshot } from '../lib/knowledgeBaseIndex.js';

export async function indexKnowledgeBaseSnapshot(
  knowledgeBaseId: string,
  sha?: string
): Promise<{ snapshotId: string; sha: string }> {
  const snapshot = await buildSnapshot(knowledgeBaseId, sha);
  return { sha: snapshot.sha, snapshotId: snapshot.id };
}

export async function getKnowledgeBasesForSync(): Promise<string[]> {
  const bases = await runUnscoped(
    'knowledge base sync indexes active sources across organizations',
    ['KnowledgeBase'],
    () =>
      prisma.knowledgeBase.findMany({
        orderBy: { id: 'asc' },
        select: { id: true },
        where: { connection: { isActive: true, type: 'git_repo' }, status: 'OK' },
      })
  );
  return bases.map((kb) => kb.id);
}
