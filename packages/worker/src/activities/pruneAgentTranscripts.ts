/**
 * The agent-transcript retention sweep (runs on the `AGENT_TRANSCRIPT_PRUNE_*`
 * schedule): deletes transcripts past `workflow.transcriptRetentionDays`,
 * abandons transcripts left `open` by a worker that died mid-attempt, and
 * removes orphan transcript-part artifacts whose part row was never written.
 *
 * Transcripts under a legal hold are never deleted. A transcript's run may be
 * long gone — `runId` is `SetNull`, which is what lets them outlive it.
 *
 * Every `AgentTranscript` query goes through `runUnscoped`: the model is
 * tenant-scoped and this is a deployment-wide sweep with no tenant predicate.
 */

import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { deleteArtifact } from '@auto-swe/shared/lib/artifactStore';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { logWarn } from '../lib/activityLog.js';
import { PRUNE_BATCH, PRUNE_MAX_BATCHES } from './pruneAutomationDecisions.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneAgentTranscriptsResult {
  /** Transcripts deleted past retention (their parts cascade with them). */
  deleted: number;
  /** Open transcripts left by a dead worker, marked abandoned. */
  abandoned: number;
  /** Transcript-part artifacts with no part row left, deleted. */
  orphanArtifacts: number;
  retentionDays: number;
  /** True when the sweep stopped at its batch limit with older rows left. */
  more: boolean;
}

export async function pruneAgentTranscripts(
  now: Date = new Date()
): Promise<PruneAgentTranscriptsResult> {
  const retentionDays = await resolveSetting('workflow.transcriptRetentionDays', {});
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const staleCutoff = new Date(now.getTime() - DAY_MS);

  let deleted = 0;
  let more = false;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const transcripts = await runUnscoped(
      'transcript retention sweep deletes every expired non-held transcript',
      ['AgentTranscript'],
      () =>
        prisma.agentTranscript.findMany({
          orderBy: { createdAt: 'asc' },
          select: { id: true, parts: { select: { artifactId: true } } },
          take: PRUNE_BATCH,
          // A live attempt is never "expired"; a run-level hold placed after
          // this transcript's create still protects it (the row only copies
          // the hold at record time).
          where: {
            createdAt: { lt: cutoff },
            legalHold: false,
            OR: [{ runId: null }, { run: { transcriptLegalHold: false } }],
            status: { not: 'open' },
          },
        })
    );
    if (transcripts.length === 0) {
      break;
    }
    for (const transcript of transcripts) {
      const artifactIds = transcript.parts.map((p) => p.artifactId);
      // The row goes first: `AgentTranscriptPart.artifactId` is `onDelete:
      // Restrict`, so an artifact cannot be deleted while its part row exists.
      // Deleting the transcript cascades the parts, and an artifact deletion
      // that then fails leaves an orphan the pass below reaps.
      await prisma.agentTranscript.delete({ where: { id: transcript.id } });
      for (const artifactId of artifactIds) {
        await deleteArtifact(artifactId);
      }
      deleted += 1;
    }
    if (transcripts.length < PRUNE_BATCH) {
      break;
    }
    if (batch === PRUNE_MAX_BATCHES - 1) {
      more = true;
    }
  }

  // A transcript still 'open' a day after its last write belongs to a worker
  // that died mid-attempt; its written parts are kept, marked so the sweep
  // does not revisit them.
  const { count: abandoned } = await runUnscoped(
    'transcript retention sweep marks every stale open transcript abandoned',
    ['AgentTranscript'],
    () =>
      prisma.agentTranscript.updateMany({
        data: { status: 'abandoned' },
        where: { status: 'open', updatedAt: { lt: staleCutoff } },
      })
  );

  // A part row insert can fail after its artifact was written; the artifact is
  // then kind 'agent-transcript-part' with no part row — an orphan nobody reads.
  const orphans = await prisma.workflowArtifact.findMany({
    select: { id: true },
    take: PRUNE_BATCH,
    where: {
      createdAt: { lt: staleCutoff },
      kind: 'agent-transcript-part',
      transcriptParts: { none: {} },
    },
  });
  for (const orphan of orphans) {
    await deleteArtifact(orphan.id);
  }

  if (more) {
    logWarn('agent transcript sweep stopped at its batch limit; the next sweep continues', {
      deleted,
      retentionDays,
    });
  }
  return { abandoned, deleted, more, orphanArtifacts: orphans.length, retentionDays };
}
