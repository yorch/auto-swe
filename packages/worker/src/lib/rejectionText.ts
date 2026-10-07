/** What a rejection says when the stored shape carries no written reason. */
export const UNWORDED_REJECTION =
  'One or more reviewers rejected the change without a written reason.';

/**
 * The text of a review rejection, whatever shape the template stored it in.
 *
 * A review loop stores the review network's `rejectionSummary`, which is
 * already text. A fan-out review (`consensus-review`) stores the fan-out's
 * `results` instead: one entry per reviewer branch, where a rejecting branch
 * carries its own summary in `exports` and a crashed branch an `error`. Read
 * as-is, that array is not text at all, so a fix session handed it fails and a
 * lesson built from it has no rejection.
 *
 * Approving branches are skipped. A review result object gives its
 * `rejectionSummary`. Any other value that was stored (an array or object with
 * no text in it) still records that a rejection happened, as
 * {@link UNWORDED_REJECTION}; only nothing stored (`undefined`, `null`) is no
 * rejection, `''`. Pure and import-free, so the workflow isolate can call it as
 * well as an activity.
 */
export function rejectionText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  if (!Array.isArray(value)) {
    const summary = (value as { rejectionSummary?: unknown }).rejectionSummary;
    return typeof summary === 'string' && summary.trim() !== '' ? summary : UNWORDED_REJECTION;
  }
  const parts: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry.trim() !== '') {
        parts.push(entry);
      }
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const branch = entry as { status?: unknown; exports?: unknown; error?: unknown };
    if (branch.status === 'SUCCESS') {
      continue;
    }
    if (branch.exports && typeof branch.exports === 'object') {
      for (const exported of Object.values(branch.exports as Record<string, unknown>)) {
        if (typeof exported === 'string' && exported.trim() !== '') {
          parts.push(exported);
        }
      }
    }
    if (typeof branch.error === 'string' && branch.error.trim() !== '') {
      parts.push(`A reviewer failed: ${branch.error}`);
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : UNWORDED_REJECTION;
}
