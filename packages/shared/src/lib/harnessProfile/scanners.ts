import { resolveRegexBudgetMs, runRegexBatch, toRegexSpecs } from '../regexExec.js';
import { shellScanTargets } from '../regexSafety.js';
import { makePatternLoader } from '../scannerPatternLoader.js';
import { scanSkillContent } from '../skillScanner.js';

/** What one advisory scan found: pattern keys, and whether every rule ran over everything. */
export interface ScanOutcome {
  hits: string[];
  incomplete: boolean;
}

export interface ProfileScanners {
  /** Prose that reaches a model: injection and exfiltration patterns. */
  text(text: string): Promise<ScanOutcome>;
  /** A command or script that runs in the container: the SHELL_COMMAND patterns. */
  shell(command: string): Promise<ScanOutcome>;
}

const shellPatterns = makePatternLoader('SHELL_COMMAND', 'harnessProfileShellScan');

/**
 * The platform's own scanners, used advisorily: a failure never throws and is never reported as
 * clean (it is `incomplete`). Nothing here executes the scanned text.
 */
export const defaultScanners: ProfileScanners = {
  async shell(command) {
    try {
      const patterns = await shellPatterns.load();
      const { hits, incomplete, quarantinedPatternKeys } = await runRegexBatch(
        toRegexSpecs(patterns, 'shell:'),
        shellScanTargets(command).map((text, i) => ({ key: String(i), text })),
        { budgetMs: resolveRegexBudgetMs(), label: 'harnessProfileShellScan' }
      );
      return {
        hits: [...new Set(hits.map((h) => h.patternKey))],
        incomplete: incomplete || quarantinedPatternKeys.length > 0,
      };
    } catch {
      return { hits: [], incomplete: true };
    }
  },
  async text(text) {
    try {
      const scan = await scanSkillContent(text, { full: true });
      return { hits: scan.warnings, incomplete: scan.incomplete };
    } catch {
      return { hits: [], incomplete: true };
    }
  },
};
