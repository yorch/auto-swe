/** The marker the gateway appends when a content scan could not run every pattern (`skillScan.ts`). */
export const SCAN_INCOMPLETE = 'scan-incomplete: some patterns could not be evaluated';

/**
 * What a saved prompt's scan warnings say: a scan that could not finish is not a finding, so the
 * marker alone never reads as "flagged". Findings and the marker together say both.
 */
export function scanWarningLead(warnings: readonly string[]): string {
  const incomplete = warnings.includes(SCAN_INCOMPLETE);
  const findings = warnings.some((w) => w !== SCAN_INCOMPLETE);
  if (incomplete && !findings) {
    return 'Saved, but the content scanner could not fully scan the prompt. Review it before relying on the agent:';
  }
  if (incomplete) {
    return 'Saved, but the content scanner flagged the prompt and could not fully scan it. Review it before relying on the agent:';
  }
  return 'Saved, but the content scanner flagged the prompt. Review it before relying on the agent:';
}
