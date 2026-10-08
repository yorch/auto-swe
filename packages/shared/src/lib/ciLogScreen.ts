import { scanSkillContent } from './skillScanner.js';

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
  const scan = await scanSkillContent(text, { full: true });
  const matches = scan.warnings
    .filter((key) => key.startsWith(INJECTION_KEY_PREFIX))
    .map((key) => key.slice(INJECTION_KEY_PREFIX.length))
    .filter((label) => !NOT_FOR_LOGS.has(label));
  return { incomplete: scan.incomplete === true, matches };
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
