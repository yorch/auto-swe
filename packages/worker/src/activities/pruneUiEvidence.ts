import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { deleteArtifact } from '@auto-swe/shared/lib/artifactStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 100;
const PRUNE_MAX_BATCHES = 100;

export interface PruneUiEvidenceResult {
  deleted: number;
  retentionDays: number;
  more: boolean;
}

export async function pruneUiEvidence(now: Date = new Date()): Promise<PruneUiEvidenceResult> {
  const retentionDays = await resolveSetting('uiValidation.evidenceRetentionDays');
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  let deleted = 0;
  let more = false;

  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const evidence = await prisma.runEvidence.findMany({
      orderBy: { createdAt: 'asc' },
      select: { artifactId: true },
      take: PRUNE_BATCH,
      where: { createdAt: { lt: cutoff } },
    });
    if (evidence.length === 0) {
      break;
    }
    for (const row of evidence) {
      await deleteArtifact(row.artifactId);
      deleted += 1;
    }
    if (evidence.length < PRUNE_BATCH) {
      break;
    }
    if (batch === PRUNE_MAX_BATCHES - 1) {
      more = true;
    }
  }

  return { deleted, more, retentionDays };
}
