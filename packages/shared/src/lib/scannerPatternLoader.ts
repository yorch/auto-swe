import type { ScannerPatternType } from './scannerPatternTypes.js';

export { SCANNER_PATTERN_TYPES, type ScannerPatternType } from './scannerPatternTypes.js';

/**
 * TTL of every DB-backed scanner-pattern cache. The gateway and the worker are
 * separate processes with no cross-process invalidation, so a pattern edit
 * takes effect once this lapses in each; both read this one value.
 */
export const SCANNER_PATTERN_CACHE_TTL_MS = 60_000;
const CACHE_TTL_MS = SCANNER_PATTERN_CACHE_TTL_MS;

// Lazy DB access — importing a scanner must not require DATABASE_URL; the
// client is loaded on the first `load()`, like the other shared resolvers.
async function db() {
  const { prisma } = await import('../db.js');
  return prisma;
}

/**
 * A stored pattern, kept as source + flags rather than a compiled `RegExp`:
 * execution happens inside the bounded executor thread (`regexExec.ts`), which
 * compiles its own copy, so nothing here needs a live RegExp object.
 */
export interface CachedEntry {
  label: string;
  source: string;
  flags: string;
  type: ScannerPatternType;
}

/**
 * Returns a `load()` / `invalidate()` pair backed by a per-instance in-memory
 * TTL cache ({@link CACHE_TTL_MS}) over the active patterns of `types`. The one
 * implementation behind every DB-backed scanner — the gateway's skill scanner
 * and the worker's shell / code-security / sensitive-file scanners — so the
 * load rules cannot drift between them.
 */
export function makePatternLoader(
  types: ScannerPatternType | readonly ScannerPatternType[],
  logPrefix: string
) {
  const wanted = typeof types === 'string' ? [types] : [...types];
  let cache: { entries: CachedEntry[]; fetchedAt: number } | null = null;

  async function load(): Promise<CachedEntry[]> {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      return cache.entries;
    }
    const prisma = await db();
    const rows = await prisma.scannerPattern.findMany({
      orderBy: { label: 'asc' },
      where: {
        isActive: true,
        ...(wanted.length === 1 ? { type: wanted[0] } : { type: { in: wanted } }),
      },
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
      entries.push({
        flags: r.flags,
        label: r.label,
        source: r.pattern,
        type: r.type as ScannerPatternType,
      });
    }
    cache = { entries, fetchedAt: now };
    return entries;
  }

  function invalidate(): void {
    cache = null;
  }

  return { invalidate, load };
}
