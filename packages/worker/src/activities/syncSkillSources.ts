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
import {
  type SourceSweepResult,
  sweepHarnessProfiles,
  sweepSkillSources,
} from '@auto-swe/shared/lib/skillSourceSync';
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
  await syncHarnessProfiles();
  return result;
}

/**
 * The same check for approved harness profiles, in the same run: each profile's ref is resolved
 * once and the answer recorded on the profile. A failure here never fails the skill-source sweep
 * (and the result of that sweep is unchanged), so it is logged by count and id only.
 */
async function syncHarnessProfiles(): Promise<void> {
  try {
    const result = await sweepHarnessProfiles(prisma);
    for (const p of result.profiles) {
      if (p.status === 'ERROR') {
        log.warn(
          'harness profile check failed; its tracking status is ERROR until a check succeeds',
          {
            error: p.error,
            profileId: p.id,
          }
        );
      }
    }
    log.info('harness profile sync complete', {
      checked: result.checked,
      errors: result.errors,
      ok: result.ok,
      skipped: result.skipped,
      updateAvailable: result.updateAvailable,
    });
  } catch {
    log.warn('harness profile sync could not run; the next run asks again');
  }
}
