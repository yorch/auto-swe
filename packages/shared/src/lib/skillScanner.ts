import { resolveRegexBudgetMs, runRegexBatch, toRegexSpecs } from './regexExec.js';
import { capScanText } from './regexSafety.js';
import { makePatternLoader } from './scannerPatternLoader.js';

const { load: loadPatterns, invalidate } = makePatternLoader(
  ['INJECTION', 'EXFILTRATION'],
  'skillScanner'
);

export { invalidate as invalidateScannerPatternCache };

export interface SkillScanResult {
  safe: boolean;
  warnings: string[];
  /**
   * True when a pattern exceeded its execution budget and the scan is therefore
   * partial. Advisory at every call site, so this is reported rather than
   * thrown — but a caller that wants to be conservative can read it.
   */
  incomplete: boolean;
}

/**
 * Scans skill text / LLM output for injection and exfiltration patterns.
 *
 * ADVISORY at every call site, which is what makes both bounds here acceptable:
 * the text is truncated at {@link capScanText}'s cap, and a pattern that burns
 * the executor's budget degrades the scan instead of blocking anything.
 */
export async function scanSkillContent(promptText: string): Promise<SkillScanResult> {
  const patterns = await loadPatterns();
  const injection = patterns.filter((p) => p.type === 'INJECTION');
  const exfiltration = patterns.filter((p) => p.type === 'EXFILTRATION');
  const text = capScanText(promptText);
  const specs = [
    ...toRegexSpecs(injection, 'injection:'),
    ...toRegexSpecs(exfiltration, 'exfiltration:'),
  ];
  const budgetMs = await resolveRegexBudgetMs();
  const { hits, incomplete } = await runRegexBatch(specs, [{ key: 'text', text }], {
    budgetMs,
    label: 'skillScanner',
  });
  const warnings = hits.map((h) => h.patternKey);
  return { incomplete, safe: warnings.length === 0, warnings };
}
