import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { deleteArtifact, deleteObjectFromBucket } from '@auto-swe/shared/lib/artifactStore';
import { logWarn } from '../lib/activityLog.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 100;
const PRUNE_MAX_BATCHES = 100;

/**
 * Key of the public copy `buildPrUiEvidence` may write for a screenshot. The
 * copy lives outside the artifact store, so retention has to delete it too or a
 * screenshot outlives the run's access-controlled evidence.
 */
export function publicEvidenceKey(runId: string, evidenceId: string): string {
  return `ui-evidence/${runId}/${evidenceId}.png`;
}

export interface PruneUiEvidenceResult {
  deleted: number;
  retentionDays: number;
  more: boolean;
  /** Public copies removed alongside their evidence (best effort). */
  publicCopiesDeleted: number;
}

export async function pruneUiEvidence(now: Date = new Date()): Promise<PruneUiEvidenceResult> {
  const retentionDays = await resolveSetting('uiValidation.evidenceRetentionDays');
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const publicBucket = process.env.UI_EVIDENCE_PUBLIC_BUCKET?.trim();
  let deleted = 0;
  let publicCopiesDeleted = 0;
  let publicDeleteFailures = 0;
  let more = false;

  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const evidence = await prisma.runEvidence.findMany({
      orderBy: { createdAt: 'asc' },
      select: { artifactId: true, id: true, kind: true, runId: true },
      take: PRUNE_BATCH,
      where: { createdAt: { lt: cutoff } },
    });
    if (evidence.length === 0) {
      break;
    }
    for (const row of evidence) {
      await deleteArtifact(row.artifactId);
      deleted += 1;
      if (publicBucket && row.kind === 'screenshot') {
        try {
          await deleteObjectFromBucket(publicBucket, publicEvidenceKey(row.runId, row.id));
          publicCopiesDeleted += 1;
        } catch {
          publicDeleteFailures += 1;
        }
      }
    }
    if (evidence.length < PRUNE_BATCH) {
      break;
    }
    if (batch === PRUNE_MAX_BATCHES - 1) {
      more = true;
    }
  }

  if (publicDeleteFailures > 0) {
    logWarn('Could not delete some public UI evidence copies during retention', {
      failures: publicDeleteFailures,
      publicCopiesDeleted,
    });
  }

  return { deleted, more, publicCopiesDeleted, retentionDays };
}
