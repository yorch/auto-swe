import { resolveRegexBudgetMs, runRegexBatch, toRegexSpecs } from './regexExec.js';
import { chunkScanText } from './regexSafety.js';
import { makePatternLoader } from './scannerPatternLoader.js';

// INJECTION only, loaded on their own: a slow or quarantined EXFILTRATION row must not make
// every log "incomplete", and their cost is not paid for nothing.
const { load: loadInjectionPatterns, invalidate } = makePatternLoader('INJECTION', 'ciLogScreen');

export { invalidate as invalidateCiLogScreenCache };

/**
 * Screening CI log text for prompt-injection phrasing before an agent acts on it (the CI
 * triage template). Here rather than in the worker so its test runs against the shipped
 * scanner patterns.
 */

const INJECTION_KEY_PREFIX = 'injection:';

/**
 * Injection patterns that match ordinary build output and so cannot screen a log:
 * `{{` / `{%` is every Go, Helm, Jinja or Actions expression a log echoes.
 */
const NOT_FOR_LOGS = new Set(['template-injection']);

/**
 * The prompt-injection patterns a CI log matches, by label, and whether the scan could not
 * run every pattern. Only INJECTION patterns screen a log: the EXFILTRATION set is written
 * for prose (`https?://\S+`, `curl `, `> /dev/`) and matches nearly every build log, the
 * same reason it is kept out of the shell scanner and the memory guard. Every character is
 * scanned (`full`), because a clean result is relied on. Throws when the scan cannot run.
 */
export async function ciLogInjectionMatches(
  text: string
): Promise<{ matches: string[]; incomplete: boolean }> {
  if (!text) {
    return { incomplete: false, matches: [] };
  }
  const patterns = (await loadInjectionPatterns()).filter((p) => !NOT_FOR_LOGS.has(p.label));
  const targets = chunkScanText(text).map((t, i) => ({ key: `text:${i}`, text: t }));
  const { hits, incomplete, quarantinedPatternKeys } = await runRegexBatch(
    toRegexSpecs(patterns, INJECTION_KEY_PREFIX),
    targets,
    { budgetMs: resolveRegexBudgetMs(), label: 'ciLogScreen' }
  );
  const matches = [...new Set(hits.map((h) => h.patternKey.slice(INJECTION_KEY_PREFIX.length)))];
  // A quarantined pattern was skipped, so the scan did not run every rule.
  return { incomplete: incomplete || quarantinedPatternKeys.length > 0, matches };
}

/**
 * Whether a log may be used to change code: no injection pattern matched and the scan
 * completed. A scan that throws or is incomplete cannot say the log is clean, so it is not.
 */
export async function ciLogIsUsable(text: string): Promise<boolean> {
  try {
    const scan = await ciLogInjectionMatches(text);
    return scan.matches.length === 0 && !scan.incomplete;
  } catch {
    return false;
  }
}
