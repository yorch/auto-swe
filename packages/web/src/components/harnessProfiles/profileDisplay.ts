import { ApiError } from '@/lib/api';
import { isRecord } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';

/** `abc1234` for a commit; the sha is repository-derived, so it is made visible too. */
export const shortSha = (sha: string | null | undefined): string =>
  sha ? visibleText(sha).slice(0, 7) : '—';

export function locationLabel(s: {
  host: string;
  owner: string;
  repo: string;
  path: string;
}): string {
  return visibleText(`${s.host}/${s.owner}/${s.repo}${s.path ? `/${s.path}` : ''}`);
}

export const formatBytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

/** Strings with a key that stays unique when two of them are identical. */
export const keyed = (xs: readonly string[]) =>
  xs.map((text, i) => ({ key: `${i}:${text}`, text }));

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' ? [x] : [])) : [];

export interface ProfileError {
  code: string | null;
  message: string;
  /** The reasons behind a refusal (`details.errors`), each made visible. */
  lines: string[];
  /** The preview is out of date (moved ref, changed content or warnings): preview again. */
  stale: boolean;
}

/** What to tell the admin about a failed call; the reasons may carry repository text. */
export function describeProfileError(err: unknown, fallback: string): ProfileError {
  if (!(err instanceof ApiError)) {
    return {
      code: null,
      lines: [],
      message: err instanceof Error ? err.message : fallback,
      stale: false,
    };
  }
  const d = err.details;
  const raw = isRecord(d) ? strings(d.errors) : strings(d);
  return {
    code: err.code,
    lines: raw.map((l) => visibleText(l)),
    message: visibleText(err.message),
    stale: err.code === 'PREVIEW_STALE' || err.code === 'SHA_MOVED',
  };
}
