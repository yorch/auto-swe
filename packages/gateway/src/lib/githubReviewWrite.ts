/**
 * Writes to a pull request on its host as the reviewer: a review with line comments, or an issue
 * comment. The token is the reviewer's own, saved for this repository, and is sent only to the base
 * the caller hands in, which `resolveUserCredential` has already bound to the origin the token was
 * verified against. It is never a platform credential: a review sent here must be the person's.
 *
 * Nothing here puts a token, a response body or an error's text in a result. A refusal is one of a
 * few fixed reasons, because the host's words are untrusted and may echo what was sent.
 *
 * A write is not retried and has no idempotency key: a key would have to be a marker in the text,
 * and any text holding the automation marker reads as the platform's own. So a failure that leaves
 * the outcome unknown (the connection dropped, the host answered 5xx) is reported as exactly that.
 */
import { hostFamily } from '@auto-swe/shared/lib/githubHostScope';
import { createGuardedFetch } from '@auto-swe/shared/lib/guardedDispatcher';
import { z } from 'zod';

const REQUEST_TIMEOUT_MS = 30_000;

export type ReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export type WriteTarget = { apiUrl: string; token: string };
export type WriteRepo = { organizationName: string; repoName: string };

export type WriteFailure = 'forbidden' | 'not-found' | 'rate-limited' | 'rejected' | 'unknown';

export type WriteResult =
  | {
      type: 'ok';
      /** The host's id for what was created; null if it answered success without one. */
      id: number | null;
      /** Where it can be read on the host; only ever an http(s) address. */
      url: string | null;
    }
  | { type: 'failed'; reason: WriteFailure };

export type WriteDeps = { fetchImpl?: typeof fetch };

export const WRITE_FAILURE_MESSAGES: Record<WriteFailure, string> = {
  forbidden:
    'The host refused your saved token. It may have expired, or it may not be allowed to write to this repository.',
  'not-found':
    'The host could not find the pull request, or your saved token cannot see this repository.',
  'rate-limited': 'The host is limiting requests. Try again in a minute.',
  rejected:
    'The host rejected it. A pull request’s author cannot approve it, and a comment must be on a line the pull request changes.',
  unknown:
    'The host did not answer clearly, so it may or may not have been sent. Check the pull request on the host before trying again.',
};

const Created = z.object({ html_url: z.string().optional(), id: z.number().int().optional() });

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

async function send(
  target: WriteTarget,
  path: string,
  payload: unknown,
  deps: WriteDeps
): Promise<WriteResult> {
  const doFetch =
    deps.fetchImpl ??
    createGuardedFetch({ allowPrivate: hostFamily(target.apiUrl) !== 'github.com' });
  let res: Response;
  try {
    res = await doFetch(`${target.apiUrl.replace(/\/$/, '')}${path}`, {
      body: JSON.stringify(payload),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${target.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'auto-swe/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Sent or not, nobody can say: the request may have reached the host before the failure.
    return { reason: 'unknown', type: 'failed' };
  }
  if (res.ok) {
    const parsed = Created.safeParse(await res.json().catch(() => null));
    return {
      id: parsed.success ? (parsed.data.id ?? null) : null,
      type: 'ok',
      url: parsed.success ? httpUrlOrNull(parsed.data.html_url) : null,
    };
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

const repoPath = (repo: WriteRepo) =>
  `/repos/${encodeURIComponent(repo.organizationName)}/${encodeURIComponent(repo.repoName)}`;

/**
 * A review with its line comments, as one request so the host shows them as one review. Each
 * comment is on a single line of the file's new side, which is the only kind the page writes.
 * `commitId` pins the review to the head the reviewer saw.
 */
export function postReview(
  target: WriteTarget,
  repo: WriteRepo,
  prNumber: number,
  input: {
    body: string;
    comments: readonly { body: string; line: number; path: string }[];
    commitId: string;
    event: ReviewEvent;
  },
  deps: WriteDeps = {}
): Promise<WriteResult> {
  return send(
    target,
    `${repoPath(repo)}/pulls/${prNumber}/reviews`,
    {
      commit_id: input.commitId,
      event: input.event,
      ...(input.body !== '' && { body: input.body }),
      ...(input.comments.length > 0 && {
        comments: input.comments.map((c) => ({
          body: c.body,
          line: c.line,
          path: c.path,
          side: 'RIGHT',
        })),
      }),
    },
    deps
  );
}

/** A comment on the pull request's conversation, which is where `/auto-swe fix` is read. */
export function postIssueComment(
  target: WriteTarget,
  repo: WriteRepo,
  prNumber: number,
  body: string,
  deps: WriteDeps = {}
): Promise<WriteResult> {
  return send(target, `${repoPath(repo)}/issues/${prNumber}/comments`, { body }, deps);
}
