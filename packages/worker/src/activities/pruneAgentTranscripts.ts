/**
 * The agent-transcript retention sweep (runs on the `AGENT_TRANSCRIPT_PRUNE_*`
 * schedule): deletes transcripts past `workflow.transcriptRetentionDays`,
 * abandons transcripts left `open` by a worker that died mid-attempt, deletes
 * transcript access-log rows past `workflow.transcriptAccessLogRetentionDays`,
 * marks access-log rows still `started` after an hour `aborted`, deletes
 * artifacts left `pending` by an S3 upload that never completed (any kind,
 * not only transcript parts), and removes orphan transcript-part
 * artifacts whose part row was never written.
 *
 * Transcripts under a legal hold are never deleted. A transcript's run may be
 * long gone — `runId` is `SetNull`, which is what lets them outlive it.
 *
 * Every `AgentTranscript` query goes through `runUnscoped`: the model is
 * tenant-scoped and this is a deployment-wide sweep with no tenant predicate.
 */

import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { deleteArtifact, deletePendingArtifact } from '@auto-swe/shared/lib/artifactStore';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { logWarn } from '../lib/activityLog.js';
import { PRUNE_BATCH, PRUNE_MAX_BATCHES } from './pruneAutomationDecisions.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A `started` access row older than this belongs to a gateway that never completed it. */
const ACCESS_STARTED_STALE_MS = 60 * 60 * 1000;

export interface PruneAgentTranscriptsResult {
  /** Transcripts deleted past retention (their parts cascade with them). */
  deleted: number;
  /** Open transcripts left by a dead worker, marked abandoned. */
  abandoned: number;
  /** Transcript-part artifacts with no part row left, deleted. */
  orphanArtifacts: number;
  /** Artifacts left `pending` by an upload that never completed, deleted with their objects. */
  pendingArtifacts: number;
  /** Pending artifacts whose deletion failed this sweep (logged; retried next sweep). */
  pendingArtifactFailures: number;
  /** Transcript access-log rows deleted past their retention. */
  accessLogDeleted: number;
  /** Access-log rows still `started` an hour on, marked `aborted`. */
  accessLogReconciled: number;
  accessLogRetentionDays: number;
  retentionDays: number;
  /** True when the sweep stopped at its batch limit with older rows left. */
  more: boolean;
}

export async function pruneAgentTranscripts(
  now: Date = new Date()
): Promise<PruneAgentTranscriptsResult> {
  const retentionDays = await resolveSetting('workflow.transcriptRetentionDays', {});
  const accessLogRetentionDays = await resolveSetting(
    'workflow.transcriptAccessLogRetentionDays',
    {}
  );
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
            runLegalHold: false,
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
      // The hold predicates are repeated in the delete: a hold placed after the batch was
      // selected (the batch takes seconds to minutes) must still protect the transcript.
      const removed = await prisma.agentTranscript.deleteMany({
        where: {
          id: transcript.id,
          legalHold: false,
          OR: [{ runId: null }, { run: { transcriptLegalHold: false } }],
          runLegalHold: false,
        },
      });
      if (removed.count === 0) {
        continue;
      }
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

  // The access log is kept on its own clock: a row outlives the transcript it
  // names, so it is pruned by age alone, in batches like the other ledgers.
  const accessLogCutoff = new Date(now.getTime() - accessLogRetentionDays * DAY_MS);
  let accessLogDeleted = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const ids = await prisma.transcriptAccessLog.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: PRUNE_BATCH,
      where: { createdAt: { lt: accessLogCutoff } },
    });
    if (ids.length === 0) {
      break;
    }
    const { count } = await prisma.transcriptAccessLog.deleteMany({
      where: { id: { in: ids.map((r) => r.id) } },
    });
    accessLogDeleted += count;
    if (ids.length < PRUNE_BATCH) {
      break;
    }
    if (batch === PRUNE_MAX_BATCHES - 1) {
      more = true;
    }
  }

  // A gateway that died mid-stream (or lost its database connection) never
  // completes its row; an hour on, the access cannot still be running.
  const { count: accessLogReconciled } = await prisma.transcriptAccessLog.updateMany({
    data: { completedAt: now, outcome: 'aborted' },
    where: {
      createdAt: { lt: new Date(now.getTime() - ACCESS_STARTED_STALE_MS) },
      outcome: 'started',
    },
  });

  // An S3 artifact's row is written `pending` before its upload and marked
  // ready after; one still pending a day later belongs to a writer that died
  // or whose upload failed (the store may have kept the object anyway). Its
  // object goes, then the row. One that fails is logged and counted, and the
  // walk moves on by id, so a store error neither stops the passes below nor
  // makes this one revisit the same rows.
  let pendingArtifacts = 0;
  let pendingArtifactFailures = 0;
  let pendingCursor: string | undefined;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const pending = await prisma.workflowArtifact.findMany({
      orderBy: { id: 'asc' },
      select: { id: true },
      take: PRUNE_BATCH,
      where: {
        createdAt: { lt: staleCutoff },
        status: 'pending',
        ...(pendingCursor ? { id: { gt: pendingCursor } } : {}),
      },
    });
    for (const artifact of pending) {
      try {
        if (await deletePendingArtifact(artifact.id)) {
          pendingArtifacts += 1;
        }
      } catch (err) {
        pendingArtifactFailures += 1;
        logWarn('pending artifact could not be deleted; the next sweep retries it', {
          artifactId: artifact.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    pendingCursor = pending.at(-1)?.id;
    if (pending.length < PRUNE_BATCH) {
      break;
    }
    if (batch === PRUNE_MAX_BATCHES - 1) {
      more = true;
    }
  }

  // A part row insert can fail after its artifact was written; the artifact is
  // then kind 'agent-transcript-part' with no part row — an orphan nobody reads.
  const orphans = await prisma.workflowArtifact.findMany({
    select: { id: true },
    take: PRUNE_BATCH,
    where: {
      createdAt: { lt: staleCutoff },
      kind: 'agent-transcript-part',
      // A pending part is the pass above's.
      status: 'ready',
      transcriptParts: { none: {} },
    },
  });
  for (const orphan of orphans) {
    await deleteArtifact(orphan.id);
  }

  if (more) {
    logWarn('agent transcript sweep stopped at its batch limit; the next sweep continues', {
      accessLogDeleted,
      deleted,
      retentionDays,
    });
  }
  return {
    abandoned,
    accessLogDeleted,
    accessLogReconciled,
    accessLogRetentionDays,
    deleted,
    more,
    orphanArtifacts: orphans.length,
    pendingArtifactFailures,
    pendingArtifacts,
    retentionDays,
  };
}
