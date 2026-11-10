/**
 * The scheduled outcome report (docs/outcome-metrics.md): reads the deployment's run data, builds the
 * report over the trailing complete UTC days and stores it as a `outcome-report` artifact, keeping the
 * newest few. It changes nothing else. The gateway serves the newest snapshot.
 *
 * This runs from a Schedule with no `WorkflowRun` row, and Temporal persists the result and every
 * log line, so both carry ids and counts only: never a repository or template name.
 */
import { prisma } from '@auto-swe/shared/db';
import { deleteArtifact, putArtifact } from '@auto-swe/shared/lib/artifactStore';
import {
  buildOutcomeReport,
  OUTCOME_REPORT_ARTIFACT_KIND,
} from '@auto-swe/shared/lib/outcomeReport';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { log } from '@temporalio/activity';

export const OUTCOME_REPORT_SNAPSHOTS_KEPT = 8;

export interface GenerateOutcomeReportResult {
  artifactId: string;
  windowStart: string;
  windowEnd: string;
  workItems: number;
  prsMerged: number;
  truncated: boolean;
  pruned: number;
}

export async function generateOutcomeReport(): Promise<GenerateOutcomeReportResult> {
  const report = await buildOutcomeReport(prisma);
  const ref = await putArtifact({
    body: JSON.stringify(report),
    contentType: 'application/json',
    kind: OUTCOME_REPORT_ARTIFACT_KIND,
  });

  // Retention is best effort: a snapshot that cannot be deleted now is retried by the next run.
  let pruned = 0;
  try {
    const stale = await runUnscoped(
      'the outcome report keeps its newest snapshots',
      ['WorkflowArtifact'],
      () =>
        prisma.workflowArtifact.findMany({
          orderBy: { createdAt: 'desc' },
          select: { id: true },
          skip: OUTCOME_REPORT_SNAPSHOTS_KEPT,
          where: { kind: OUTCOME_REPORT_ARTIFACT_KIND, runId: null },
        })
    );
    for (const { id } of stale) {
      await deleteArtifact(id);
      pruned += 1;
    }
  } catch {
    log.warn('outcome report snapshot retention failed; the next run retries it');
  }

  log.info('outcome report generated', {
    artifactId: ref.id,
    prsMerged: report.overall.prsMerged,
    pruned,
    truncated: report.inputs.truncated,
    workItems: report.overall.workItems,
  });
  return {
    artifactId: ref.id,
    prsMerged: report.overall.prsMerged,
    pruned,
    truncated: report.inputs.truncated,
    windowEnd: report.window.end,
    windowStart: report.window.start,
    workItems: report.overall.workItems,
  };
}
