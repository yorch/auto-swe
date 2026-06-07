import { prisma } from '@auto-swe/shared/db';

interface CachedEntry {
  label: string;
  re: RegExp;
}

let cache: { entries: CachedEntry[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

async function loadShellPatterns(): Promise<CachedEntry[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.entries;
  }
  const rows = await prisma.scannerPattern.findMany({
    orderBy: { label: 'asc' },
    where: { isActive: true, type: 'SHELL_COMMAND' },
  });
  const entries: CachedEntry[] = [];
  for (const r of rows) {
    try {
      entries.push({ label: r.label, re: new RegExp(r.pattern, r.flags) });
    } catch {
      console.error(`[shellCommandScanner] skipping invalid pattern '${r.label}': invalid regex`);
    }
  }
  cache = { entries, fetchedAt: now };
  return entries;
}

/**
 * Checks a shell command against active SHELL_COMMAND scanner patterns.
 * Returns a human-readable block message (for the agent to self-correct) if
 * the command matches, or null if it is clean.
 */
export async function scanShellCommand(command: string): Promise<string | null> {
  const patterns = await loadShellPatterns();
  for (const { label, re } of patterns) {
    re.lastIndex = 0;
    if (re.test(command)) {
      const truncated = command.length > 200 ? `${command.slice(0, 200)}…` : command;
      return (
        `Command blocked by security policy [${label}]:\n  ${truncated}\n` +
        'Modify the command to avoid the restricted pattern and retry.'
      );
    }
  }
  return null;
}
