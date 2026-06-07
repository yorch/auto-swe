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
  const injection = rows
    .filter((r) => r.type === 'INJECTION')
    .map((r) => ({ label: r.label, re: new RegExp(r.pattern, r.flags) }));
  const exfiltration = rows
    .filter((r) => r.type === 'EXFILTRATION')
    .map((r) => ({ label: r.label, re: new RegExp(r.pattern, r.flags) }));
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
      if (re.test(promptText)) {
        warnings.push(`${prefix}:${label}`);
      }
    }
  };
  check(injection, 'injection');
  check(exfiltration, 'exfiltration');
  return { safe: warnings.length === 0, warnings };
}
