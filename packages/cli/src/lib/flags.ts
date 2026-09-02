/** Shared `--flag=value` / `--flag value` / `-o value` argument parser. */

export interface ParsedFlags {
  positional: string[];
  flags: Record<string, string>;
}

/**
 * Sentinel stored for a flag declared without a value (`--dry-run`, or
 * `--name` immediately followed by another flag). Commands that need a real
 * value check for it with {@link missingValue}.
 */
export const FLAG_PRESENT = 'true';

export function parseFlags(args: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) {
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = FLAG_PRESENT;
        }
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[a.slice(1)] = next;
        i++;
      } else {
        flags[a.slice(1)] = FLAG_PRESENT;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/**
 * The first of `keys` that was passed without a value (`--team` with nothing
 * after it), or `null` when every present flag carries one. Lets a command
 * refuse `--name` as a literal name of "true" with a one-line usage error.
 */
export function missingValue(flags: Record<string, string>, ...keys: string[]): string | null {
  for (const key of keys) {
    if (flags[key] === FLAG_PRESENT) {
      return key;
    }
  }
  return null;
}
