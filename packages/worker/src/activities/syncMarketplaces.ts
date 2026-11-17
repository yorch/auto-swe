/**
 * The scheduled marketplace check: asks the host which commit each tracked plugin marketplace's
 * ref names now and flags the ones that moved. It only records `latestSha`/`status` on the source
 * row; it never moves a pin, installs an entry or changes a profile (an administrator accepts).
 *
 * This runs from a Schedule with no `WorkflowRun` row, and Temporal persists the result and every
 * log line, so both carry only ids, counts, statuses and the fixed error strings of the shared
 * fetcher — never provider or fetch text.
 */
import { prisma } from '@auto-swe/shared/db';
import {
  type MarketplaceSweepResult,
  sweepMarketplaceSources,
} from '@auto-swe/shared/lib/marketplace';
import { log } from '@temporalio/activity';

export type SyncMarketplacesResult = MarketplaceSweepResult;

export async function syncMarketplaces(): Promise<SyncMarketplacesResult> {
  const result = await sweepMarketplaceSources(prisma);
  for (const s of result.sources) {
    if (s.status === 'ERROR') {
      log.warn('marketplace check failed; its status is ERROR until a check succeeds', {
        error: s.error,
        sourceId: s.id,
      });
    }
  }
  log.info('marketplace sync complete', {
    checked: result.checked,
    errors: result.errors,
    ok: result.ok,
    skipped: result.skipped,
    updateAvailable: result.updateAvailable,
  });
  return result;
}
