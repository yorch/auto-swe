import { ApiError } from '@/lib/api';
import { visibleText } from '@/lib/visibleText';

/** `owner/repo@abc1234`-style text for a commit; the sha is repository-controlled too. */
export const shortSha = (sha: string | null | undefined): string =>
  sha ? visibleText(sha).slice(0, 7) : '—';

export function sourceLabel(s: {
  host: string;
  owner: string;
  repo: string;
  path: string;
}): string {
  return visibleText(`${s.host}/${s.owner}/${s.repo}${s.path ? `/${s.path}` : ''}`);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' ? [x] : [])) : [];

/**
 * The lines behind a refusal, from the gateway's `error.details`: names that
 * conflict (`{name, scope}`), skills that cannot install (`{name, errors}`),
 * scan findings (`{name, warnings}`), or a bare list of names. The details
 * carry repository text, so every line is made visible.
 */
export function detailLines(details: unknown): string[] {
  if (!Array.isArray(details)) {
    return [];
  }
  return details.flatMap((d): string[] => {
    if (typeof d === 'string') {
      return [visibleText(d)];
    }
    if (typeof d !== 'object' || d === null) {
      return [];
    }
    const r = d as Record<string, unknown>;
    const name = str(r.name);
    const reasons = [...list(r.errors), ...list(r.warnings)];
    const scope = str(r.scope);
    const what =
      reasons.length > 0 ? reasons.join('; ') : scope ? `already exists (${scope} scope)` : null;
    if (name === null) {
      return what === null ? [] : [visibleText(what)];
    }
    return [visibleText(what === null ? name : `${name}: ${what}`)];
  });
}

/** What to tell the admin about a failed call: the gateway's message, plus its reasons. */
export function describeApiError(err: unknown, fallback: string) {
  if (err instanceof ApiError) {
    return {
      code: err.code,
      lines: detailLines(err.details),
      message: err.message,
      status: err.status,
    };
  }
  return {
    code: null,
    lines: [] as string[],
    message: err instanceof Error ? err.message : fallback,
    status: 0,
  };
}

/** Strings with a key that stays unique when two of them are identical. */
export const keyed = (xs: readonly string[]) =>
  xs.map((text, i) => ({ key: `${i}:${text}`, text }));
