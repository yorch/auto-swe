import { resolveRegexBudgetMs, runRegexBatch, toRegexSpecs } from './regexExec.js';
import { capScanText, chunkScanText } from './regexSafety.js';
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
   * True when the scan is partial: a pattern exceeded its execution budget or is
   * quarantined, or the pattern set could not be loaded. Reported rather than
   * thrown. An advisory caller proceeds; the memory write gate treats it as "not
   * known to be clean" and refuses.
   */
  incomplete: boolean;
  /**
   * Why the scan is incomplete. `load-failed`: the pattern set could not be read
   * (transient, no rule ran). `partial`: it was read but some rule did not run
   * to completion. Absent when the scan is complete.
   */
  incompleteReason?: 'load-failed' | 'partial';
}

export interface SkillScanOptions {
  /** Scan every character in overlapping windows instead of truncating. */
  full?: boolean;
  /**
   * Run only these pattern types (default: both). A caller that acts on one type
   * passes it, so a slow or quarantined pattern of the other cannot make its
   * result incomplete.
   */
  types?: ReadonlyArray<'INJECTION' | 'EXFILTRATION'>;
}

/**
 * Scans skill text / LLM output for injection and exfiltration patterns.
 *
 * ADVISORY at the skill, agent, rubric, bundle and LLM-output call sites, which
 * is what makes both bounds here acceptable: the text is truncated at
 * {@link capScanText}'s cap, and a pattern that burns the executor's budget
 * degrades the scan instead of blocking anything. The memory write gate is the
 * exception: it scans in full, INJECTION only, and refuses a write when the
 * result is incomplete.
 */
export async function scanSkillContent(
  promptText: string,
  opts: SkillScanOptions = {}
): Promise<SkillScanResult> {
  let patterns: Awaited<ReturnType<typeof loadPatterns>>;
  try {
    patterns = await loadPatterns();
  } catch (err) {
    // No scanner throws: a pattern store that cannot be read means no rule ran,
    // which is a scan that could not be completed, not a clean one.
    console.error(
      `[skillScanner] pattern load failed; scan incomplete: ${err instanceof Error ? err.message : String(err)}`
    );
    return { incomplete: true, incompleteReason: 'load-failed', safe: true, warnings: [] };
  }
  const types = opts.types ?? ['INJECTION', 'EXFILTRATION'];
  const injection = types.includes('INJECTION')
    ? patterns.filter((p) => p.type === 'INJECTION')
    : [];
  const exfiltration = types.includes('EXFILTRATION')
    ? patterns.filter((p) => p.type === 'EXFILTRATION')
    : [];
  // `full` covers every character in overlapping windows instead of truncating,
  // for a caller whose "clean" result is relied on rather than merely shown.
  const targets = opts.full
    ? chunkScanText(promptText).map((text, i) => ({ key: `text:${i}`, text }))
    : [{ key: 'text', text: capScanText(promptText) }];
  const specs = [
    ...toRegexSpecs(injection, 'injection:'),
    ...toRegexSpecs(exfiltration, 'exfiltration:'),
  ];
  const budgetMs = resolveRegexBudgetMs();
  const { hits, incomplete, quarantinedPatternKeys } = await runRegexBatch(specs, targets, {
    budgetMs,
    label: 'skillScanner',
  });
  const warnings = [...new Set(hits.map((h) => h.patternKey))];
  const partial = incomplete || quarantinedPatternKeys.length > 0;
  return {
    // A quarantined pattern was skipped, so the scan did not run every rule.
    incomplete: partial,
    ...(partial ? { incompleteReason: 'partial' as const } : {}),
    safe: warnings.length === 0,
    warnings,
  };
}
