import { prisma } from '@auto-swe/shared/db';

interface CachedPatterns {
  exfiltration: Array<{ label: string; re: RegExp }>;
  fetchedAt: number;
  injection: Array<{ label: string; re: RegExp }>;
}

let cache: CachedPatterns | null = null;
const CACHE_TTL_MS = 60_000;

async function loadPatterns(): Promise<CachedPatterns> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }
  const rows = await prisma.scannerPattern.findMany({
    orderBy: { label: 'asc' },
    where: { isActive: true },
  });
  const { exfiltration, injection } = rows.reduce<{
    exfiltration: Array<{ label: string; re: RegExp }>;
    injection: Array<{ label: string; re: RegExp }>;
  }>(
    (acc, r) => {
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
  const check = (patterns: Array<{ label: string; re: RegExp }>, prefix: string) => {
    for (const { label, re } of patterns) {
      re.lastIndex = 0;
      if (re.test(promptText)) {
        warnings.push(`${prefix}:${label}`);
      }
    }
  };
  check(injection, 'injection');
  check(exfiltration, 'exfiltration');
  return { safe: warnings.length === 0, warnings };
}
