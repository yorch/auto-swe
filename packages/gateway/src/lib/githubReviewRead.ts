/**
 * Reads a pull request's reviews on its host as the reviewer, to answer one question: did the
 * review whose send ended with an unknown outcome land after all? Read-only: every request here is
 * a GET. The token is the reviewer's own, handed in with a base `resolveUserCredential` has bound
 * to the origin it was verified against, and it goes nowhere else.
 *
 * A match is evidence, and no match is not: the host may be slow to list a review, the reviewer's
 * text may have been altered, or the review may never have been sent. Nothing here, and nothing
 * built on it, may say a review was NOT sent. The match uses what the platform wrote (the head, the
 * event, the text, the time window, and the line comments one to one on path, line in the numbering
 * of the head the review was sent on, side, start line and text), so an identical review sent
 * twice inside the window cannot be told apart from one.
 *
 * As in `githubReviewWrite`, nothing puts a token, a response body, the reviewer's login or an
 * error's text in a result: a failure is one of a few fixed reasons.
 */
import { hostFamily } from '@auto-swe/shared/lib/githubHostScope';
import { createGuardedFetch } from '@auto-swe/shared/lib/guardedDispatcher';
import { z } from 'zod';
import type {
  ReviewEvent,
  WriteDeps,
  WriteFailure,
  WriteRepo,
  WriteTarget,
} from './githubReviewWrite.js';

const REQUEST_TIMEOUT_MS = 30_000;
/** A send's clock and the host's may differ, and the attempt began before the host stamped it. */
const EARLY_TOLERANCE_MS = 120_000;
const LATE_TOLERANCE_MS = 60_000;
/** The window always reaches back this far: the client's clock is a hint, not a bound. */
const MIN_LOOKBACK_MS = 10 * 60_000;
/** Review pages read: the first, or the last two when the host says there are more. */
const PAGE_SIZE = 100;
/** Candidates whose line comments are read, newest first. */
const MAX_COMMENT_READS = 3;

/** One line comment a send carried, as the platform wrote it. */
export type SentComment = {
  body: string;
  line: number;
  path: string;
  side: 'LEFT' | 'RIGHT';
  startLine: number | null;
};

export type FindSentReviewInput = {
  attemptedAt: Date;
  body: string;
  comments: readonly SentComment[];
  event: ReviewEvent;
  headSha: string;
};

export type FindSentReviewResult =
  | { type: 'found'; id: number; url: string | null }
  | { type: 'not-found' }
  | { type: 'failed'; reason: WriteFailure };

export type ReadDeps = WriteDeps & { now?: () => Date };

const STATE_OF_EVENT: Record<ReviewEvent, string> = {
  APPROVE: 'APPROVED',
  COMMENT: 'COMMENTED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
};

const Account = z.object({ login: z.string().min(1) });
const Review = z.object({
  body: z.string().nullable().optional(),
  // Null when the host no longer has the commit; such a row never matches.
  commit_id: z.string().nullable().optional(),
  html_url: z.string().optional(),
  id: z.number().int(),
  state: z.string(),
  submitted_at: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).nullable().optional(),
});
type ReviewRow = z.infer<typeof Review>;
const CommentRow = z.object({
  body: z.string().nullable().optional(),
  line: z.number().int().nullable().optional(),
  original_line: z.number().int().nullable().optional(),
  original_start_line: z.number().int().nullable().optional(),
  path: z.string(),
  side: z.string().nullable().optional(),
  start_line: z.number().int().nullable().optional(),
});

const commentKey = (c: SentComment): string =>
  JSON.stringify([c.path, c.line, c.side, c.startLine, c.body.trim()]);

/** True when the listed comments are exactly `wanted`, one to one, in any order. */
function commentsMatch(listed: unknown, wanted: readonly SentComment[]): boolean {
  if (!Array.isArray(listed) || listed.length !== wanted.length) {
    return false;
  }
  const remaining = new Map<string, number>();
  for (const w of wanted) {
    const key = commentKey(w);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const raw of listed) {
    const row = CommentRow.safeParse(raw);
    // `original_*` are numbered against the head the review was sent on, as the drafts are; `line`
    // and `start_line` follow the comment's current commit and are null once it is outdated.
    const line = row.success ? (row.data.original_line ?? row.data.line) : undefined;
    if (!row.success || line === undefined || line === null) {
      return false;
    }
    const key = commentKey({
      body: row.data.body ?? '',
      line,
      path: row.data.path,
      side: row.data.side === 'LEFT' ? 'LEFT' : 'RIGHT',
      startLine: row.data.original_start_line ?? row.data.start_line ?? null,
    });
    const left = remaining.get(key) ?? 0;
    if (left === 0) {
      return false;
    }
    remaining.set(key, left - 1);
  }
  return true;
}

function httpUrlOrNull(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

type Got =
  | { type: 'ok'; json: unknown; link: string | null }
  | { type: 'failed'; reason: WriteFailure };

async function get(target: WriteTarget, path: string, doFetch: typeof fetch): Promise<Got> {
  let res: Response;
  try {
    res = await doFetch(`${target.apiUrl.replace(/\/$/, '')}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${target.token}`,
        'User-Agent': 'auto-swe/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { reason: 'unknown', type: 'failed' };
  }
  if (res.ok) {
    return { json: await res.json().catch(() => null), link: res.headers.get('link'), type: 'ok' };
  }
  if (res.status === 429) {
    return { reason: 'rate-limited', type: 'failed' };
  }
  if (
    res.status === 403 &&
    (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'))
  ) {
    return { reason: 'rate-limited', type: 'failed' };
  }
  if (res.status === 401 || res.status === 403) {
    return { reason: 'forbidden', type: 'failed' };
  }
  if (res.status === 404 || res.status === 410) {
    return { reason: 'not-found', type: 'failed' };
  }
  if (res.status >= 500) {
    return { reason: 'unknown', type: 'failed' };
  }
  return { reason: 'rejected', type: 'failed' };
}

/** True when a `Link` header names a `rel="next"` page. */
const hasNextPage = (link: string | null): boolean =>
  link?.split(',').some((part) => /;\s*rel="?next"?/.test(part)) === true;

/** The number of the last page, from a `Link` header's `rel="last"`; null when it names none. */
function lastPageOf(link: string | null): number | null {
  if (link === null) {
    return null;
  }
  for (const part of link.split(',')) {
    if (!/;\s*rel="?last"?/.test(part)) {
      continue;
    }
    const url = /<([^>]*)>/.exec(part)?.[1];
    if (url === undefined) {
      return null;
    }
    try {
      const page = Number(new URL(url).searchParams.get('page'));
      return Number.isInteger(page) && page > 0 ? page : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Looks for the review a send attempted, among the reviewer's own on the pull request. It reads
 * the first page of reviews and, when there are more, the last two pages instead of the first, so
 * a very long review history is read from its newest end, where a review just sent is.
 */
export async function findSentReview(
  target: WriteTarget,
  repo: WriteRepo,
  prNumber: number,
  input: FindSentReviewInput,
  deps: ReadDeps = {}
): Promise<FindSentReviewResult> {
  const doFetch =
    deps.fetchImpl ??
    createGuardedFetch({ allowPrivate: hostFamily(target.apiUrl) !== 'github.com' });
  const now = (deps.now ?? (() => new Date()))().getTime();
  const failed = (reason: WriteFailure): FindSentReviewResult => ({ reason, type: 'failed' });
  const base = `/repos/${encodeURIComponent(repo.organizationName)}/${encodeURIComponent(repo.repoName)}/pulls/${prNumber}/reviews`;

  const who = await get(target, '/user', doFetch);
  if (who.type === 'failed') {
    return failed(who.reason);
  }
  const me = Account.safeParse(who.json);
  if (!me.success) {
    return failed('unknown');
  }
  const login = me.data.login.toLowerCase();

  const first = await get(target, `${base}?per_page=${PAGE_SIZE}`, doFetch);
  if (first.type === 'failed') {
    return failed(first.reason);
  }
  const pages: unknown[] = [first.json];
  const last = lastPageOf(first.link);
  if (last !== null && last > 1) {
    // The last page, and the one before it: a review on the edge of a page boundary sits on either.
    const wantedPages = last === 2 ? [2] : [last - 1, last];
    for (const n of wantedPages) {
      const more = await get(target, `${base}?per_page=${PAGE_SIZE}&page=${n}`, doFetch);
      if (more.type === 'failed') {
        return failed(more.reason);
      }
      pages.push(more.json);
    }
    if (last > 2) {
      pages.shift();
    }
  }
  // Each row stands alone: one the host sends in an odd shape is skipped, not a reason to fail.
  const rows: ReviewRow[] = [];
  for (const json of pages) {
    if (!Array.isArray(json)) {
      return failed('unknown');
    }
    for (const raw of json) {
      const row = Review.safeParse(raw);
      if (row.success) {
        rows.push(row.data);
      }
    }
  }

  const earliest = Math.min(
    Math.min(input.attemptedAt.getTime(), now) - EARLY_TOLERANCE_MS,
    now - MIN_LOOKBACK_MS
  );
  const latest = now + LATE_TOLERANCE_MS;
  const wantedBody = input.body.trim();
  const candidates: { at: number; row: ReviewRow }[] = [];
  for (const row of rows) {
    const stamp = row.submitted_at ? Date.parse(row.submitted_at) : Number.NaN;
    if (
      row.user?.login.toLowerCase() === login &&
      row.commit_id?.toLowerCase() === input.headSha.toLowerCase() &&
      row.state === STATE_OF_EVENT[input.event] &&
      Number.isFinite(stamp) &&
      stamp >= earliest &&
      stamp <= latest &&
      (row.body ?? '').trim() === wantedBody
    ) {
      candidates.push({ at: stamp, row });
    }
  }
  candidates.sort((a, b) => b.at - a.at || b.row.id - a.row.id);

  // A review of the right shape is not yet the review: a reply typed on the host is one too. Its
  // line comments must be exactly the drafts the send carried.
  for (const { row } of candidates.slice(0, MAX_COMMENT_READS)) {
    const comments = await get(target, `${base}/${row.id}/comments?per_page=${PAGE_SIZE}`, doFetch);
    if (comments.type === 'failed') {
      return failed(comments.reason);
    }
    if (!Array.isArray(comments.json)) {
      return failed('unknown');
    }
    // A second page of comments means this one cannot show the whole review: a miss proves nothing.
    if (hasNextPage(comments.link)) {
      continue;
    }
    if (commentsMatch(comments.json, input.comments)) {
      return { id: row.id, type: 'found', url: httpUrlOrNull(row.html_url) };
    }
  }
  return { type: 'not-found' };
}
