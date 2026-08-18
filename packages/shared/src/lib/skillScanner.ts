import { prisma } from '@auto-swe/shared/db';
import { runRegexBatch, toRegexSpecs } from './regexExec.js';
import { capScanText } from './regexSafety.js';
import { SCANNER_PATTERN_CACHE_TTL_MS as CACHE_TTL_MS } from './scannerCache.js';

/**
 * A stored pattern kept as source + flags. Execution happens inside the bounded
 * executor thread, which compiles its own copy.
 */
interface PatternEntry {
  label: string;
  source: string;
  flags: string;
}

interface CachedPatterns {
  exfiltration: PatternEntry[];
  fetchedAt: number;
  injection: PatternEntry[];
}

let cache: CachedPatterns | null = null;

async function loadPatterns(): Promise<CachedPatterns> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }
  const rows = await prisma.scannerPattern.findMany({
    orderBy: { label: 'asc' },
    where: { isActive: true, type: { in: ['INJECTION', 'EXFILTRATION'] } },
  });
  const { exfiltration, injection } = rows.reduce<{
    exfiltration: PatternEntry[];
    injection: PatternEntry[];
  }>(
    (acc, r) => {
      // The only load-time filter is "does it compile". How costly a row is to
      // run is bounded at execution time by the executor's wall-clock budget,
      // not guessed at here.
      try {
        new RegExp(r.pattern, r.flags);
      } catch {
        console.error(`[skillScanner] skipping invalid pattern '${r.label}': invalid regex`);
        return acc;
      }
      const entry: PatternEntry = { flags: r.flags, label: r.label, source: r.pattern };
      const bucket = r.type === 'INJECTION' ? acc.injection : acc.exfiltration;
      bucket.push(entry);
      return acc;
    },
    { exfiltration: [], injection: [] }
  );
  cache = { exfiltration, fetchedAt: now, injection };
  return cache;
}

export function invalidateScannerPatternCache(): void {
  cache = null;
}

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
  const { exfiltration, injection } = await loadPatterns();
  const text = capScanText(promptText);
  const specs = [
    ...toRegexSpecs(injection, 'injection:'),
    ...toRegexSpecs(exfiltration, 'exfiltration:'),
  ];
  const { hits, incomplete } = await runRegexBatch(specs, [{ key: 'text', text }], {
    label: 'skillScanner',
  });
  const warnings = hits.map((h) => h.patternKey);
  return { incomplete, safe: warnings.length === 0, warnings };
}
