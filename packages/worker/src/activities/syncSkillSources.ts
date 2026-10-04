/**
 * The scheduled skill-source check: asks the host which commit each tracked
 * source's ref names now and flags the ones that moved. It only records
 * `latestSha`/`status` on the source row; it never changes a skill or a
 * revision (an admin reviews the diff and accepts).
 *
 * This runs from a Schedule with no `WorkflowRun` row, and Temporal persists
 * the result and every log line, so both carry only ids, counts, statuses and
 * the fixed error strings of the shared fetcher — never provider or fetch text.
 */
import { prisma } from '@auto-swe/shared/db';
import { type SourceSweepResult, sweepSkillSources } from '@auto-swe/shared/lib/skillSourceSync';
import { log } from '@temporalio/activity';

export type SyncSkillSourcesResult = SourceSweepResult;

export async function syncSkillSources(): Promise<SyncSkillSourcesResult> {
  const result = await sweepSkillSources(prisma);
  for (const s of result.sources) {
    if (s.status === 'ERROR') {
      log.warn('skill source check failed; its status is ERROR until a check succeeds', {
        error: s.error,
        sourceId: s.id,
      });
    }
  }
  log.info('skill source sync complete', {
    checked: result.checked,
    errors: result.errors,
    ok: result.ok,
    skipped: result.skipped,
    updateAvailable: result.updateAvailable,
  });
  return result;
}
