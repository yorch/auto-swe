import { prisma } from '@auto-swe/shared/db';
import { capScanText, checkRegexRuntimeSafety } from './regexSafety.js';
import { SCANNER_PATTERN_CACHE_TTL_MS as CACHE_TTL_MS } from './scannerCache.js';

interface CachedPatterns {
  exfiltration: Array<{ label: string; re: RegExp }>;
  fetchedAt: number;
  injection: Array<{ label: string; re: RegExp }>;
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
    exfiltration: Array<{ label: string; re: RegExp }>;
    injection: Array<{ label: string; re: RegExp }>;
  }>(
    (acc, r) => {
      // Both write paths (admin API, bundle install) reject unsafe patterns, but
      // rows predating that check can still be in the table — skip them here
      // rather than compiling a catastrophic pattern into a cached RegExp.
      const issue = checkRegexRuntimeSafety(r.pattern, r.flags);
      if (issue) {
        console.error(
          issue.code === 'INVALID_REGEX'
            ? `[skillScanner] skipping invalid pattern '${r.label}': invalid regex`
            : `[skillScanner] skipping unsafe pattern '${r.label}': ${issue.code} — ${issue.message}`
        );
        return acc;
      }
      try {
        const entry = { label: r.label, re: new RegExp(r.pattern, r.flags) };
        const bucket = r.type === 'INJECTION' ? acc.injection : acc.exfiltration;
        bucket.push(entry);
      } catch {
        console.error(`[skillScanner] skipping invalid pattern '${r.label}': invalid regex`);
      }
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
}

export async function scanSkillContent(promptText: string): Promise<SkillScanResult> {
  const { exfiltration, injection } = await loadPatterns();
  const warnings: string[] = [];
  // Bound the work any one pattern can do. Scanning is advisory at every call
  // site, so a truncated scan is strictly preferable to an unbounded backtrack
  // over an arbitrarily long LLM response.
  const text = capScanText(promptText);
  const check = (patterns: Array<{ label: string; re: RegExp }>, prefix: string) => {
    for (const { label, re } of patterns) {
      re.lastIndex = 0;
      if (re.test(text)) {
        warnings.push(`${prefix}:${label}`);
      }
    }
  };
  check(injection, 'injection');
  check(exfiltration, 'exfiltration');
  return { safe: warnings.length === 0, warnings };
}
