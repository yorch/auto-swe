import { prisma } from '@auto-swe/shared/db';
import { SCANNER_PATTERN_CACHE_TTL_MS as CACHE_TTL_MS } from '@auto-swe/shared/lib/scannerCache';

/**
 * A stored pattern, kept as source + flags rather than a compiled `RegExp`:
 * execution happens inside the bounded executor thread (`regexExec.ts`), which
 * compiles its own copy, so nothing here needs a live RegExp object.
 */
export interface CachedEntry {
  label: string;
  source: string;
  flags: string;
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
  | 'SHELL_COMMAND'
  | 'PII';

export function makePatternLoader(type: PatternType, logPrefix: string) {
  let cache: { entries: CachedEntry[]; fetchedAt: number } | null = null;

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
      // The only load-time filter is "does it compile" — a row that cannot be
      // turned into a RegExp would just be skipped inside the executor with no
      // way to report which one it was. Everything about how EXPENSIVE a row is
      // to run is handled by the executor's wall-clock budget, not here: a
      // load-time cost judgement can only ever be a guess, and a wrong guess
      // silently stops an admin's block rule from applying.
      try {
        new RegExp(r.pattern, r.flags);
      } catch {
        console.error(`[${logPrefix}] skipping invalid pattern '${r.label}': invalid regex`);
        continue;
      }
      entries.push({ flags: r.flags, label: r.label, source: r.pattern });
    }
    cache = { entries, fetchedAt: now };
    return entries;
  }

  function invalidate(): void {
    cache = null;
  }

  return { invalidate, load };
}
