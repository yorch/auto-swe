import { prisma } from '@auto-swe/shared/db';

interface CachedEntry {
  label: string;
  re: RegExp;
}

/**
 * Returns a load() / invalidate() pair backed by a per-instance in-memory TTL
 * cache. Each scanner module calls makePatternLoader() once at module level and
 * uses the resulting functions rather than re-implementing the cache boilerplate.
 */
// The ScannerPatternType enum values supported by pattern-loading scanners.
// Defined as a literal union to avoid importing the generated Prisma enum type
// across the package boundary (the shared package's export map doesn't expose it).
type PatternType =
  | 'CODE_SECURITY'
  | 'INJECTION'
  | 'EXFILTRATION'
  | 'SENSITIVE_FILE'
  | 'SHELL_COMMAND';

export function makePatternLoader(type: PatternType, logPrefix: string) {
  let cache: { entries: CachedEntry[]; fetchedAt: number } | null = null;
  const CACHE_TTL_MS = 60_000;

  async function load(): Promise<CachedEntry[]> {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      return cache.entries;
    }
    const rows = await prisma.scannerPattern.findMany({
      orderBy: { label: 'asc' },
      where: { isActive: true, type },
    });
    const entries: CachedEntry[] = [];
    for (const r of rows) {
      try {
        entries.push({ label: r.label, re: new RegExp(r.pattern, r.flags) });
      } catch {
        console.error(`[${logPrefix}] skipping invalid pattern '${r.label}': invalid regex`);
      }
    }
    cache = { entries, fetchedAt: now };
    return entries;
  }

  function invalidate(): void {
    cache = null;
  }

  return { invalidate, load };
}
