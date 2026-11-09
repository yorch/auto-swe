import { describe, expect, it } from 'vitest';
import { postIssueComment, postReview, WRITE_FAILURE_MESSAGES } from './githubReviewWrite.js';

const TARGET = { apiUrl: 'https://api.github.com/', token: 'tok-secret' };
const REPO = { organizationName: 'acme', repoName: 'api' };
const SHA = 'c'.repeat(40);

type Hit = { init: RequestInit; url: string };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers, status });

function host(reply: Response | (() => Response | Promise<Response>)) {
  const hits: Hit[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    hits.push({ init: init ?? {}, url: String(input) });
    return typeof reply === 'function' ? reply() : reply.clone();
  }) as typeof fetch;
  return { fetchImpl, hits };
}

const bodyOf = (hit: Hit | undefined) => JSON.parse(String(hit?.init.body));
const authOf = (hit: Hit | undefined): string | undefined =>
  (hit?.init.headers as Record<string, string> | undefined)?.Authorization;
const input = (over: Partial<Parameters<typeof postReview>[3]> = {}) => ({
  body: 'Looks good',
  comments: [{ body: 'use <=', line: 2, path: 'src/a.ts' }],
  commitId: SHA,
  event: 'COMMENT' as const,
  ...over,
});

describe('postReview', () => {
  it('sends one review with its line comments, pinned to the commit the reviewer saw', async () => {
    const { fetchImpl, hits } = host(
      json({ html_url: 'https://github.com/acme/api/pull/7#pullrequestreview-9', id: 9 })
    );
    const result = await postReview(TARGET, REPO, 7, input(), { fetchImpl });
    expect(result).toEqual({
      id: 9,
      type: 'ok',
      url: 'https://github.com/acme/api/pull/7#pullrequestreview-9',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.url).toBe('https://api.github.com/repos/acme/api/pulls/7/reviews');
    expect(hits[0]?.init.method).toBe('POST');
    expect(bodyOf(hits[0])).toEqual({
      body: 'Looks good',
      comments: [{ body: 'use <=', line: 2, path: 'src/a.ts', side: 'RIGHT' }],
      commit_id: SHA,
      event: 'COMMENT',
    });
  });

  it('sends the token only as a bearer header, and refuses redirects', async () => {
    const { fetchImpl, hits } = host(json({ id: 1 }));
    await postReview(TARGET, REPO, 7, input(), { fetchImpl });
    const headers = hits[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-secret');
    expect(hits[0]?.init.redirect).toBe('error');
    expect(hits[0]?.url).not.toContain('tok-secret');
    expect(String(hits[0]?.init.body)).not.toContain('tok-secret');
  });

  it.each(['APPROVE', 'REQUEST_CHANGES'] as const)(
    'carries the %s event as given',
    async (event) => {
      const { fetchImpl, hits } = host(json({ id: 1 }));
      await postReview(TARGET, REPO, 7, input({ event }), { fetchImpl });
      expect(bodyOf(hits[0]).event).toBe(event);
    }
  );

  it('leaves out a body and comments that there are none of', async () => {
    const { fetchImpl, hits } = host(json({ id: 1 }));
    await postReview(TARGET, REPO, 7, input({ body: '', comments: [], event: 'APPROVE' }), {
      fetchImpl,
    });
    expect(bodyOf(hits[0])).toEqual({ commit_id: SHA, event: 'APPROVE' });
  });

  it('encodes the owner and repository in the path', async () => {
    const { fetchImpl, hits } = host(json({ id: 1 }));
    await postReview(TARGET, { organizationName: 'a/b', repoName: 'c d' }, 7, input(), {
      fetchImpl,
    });
    expect(hits[0]?.url).toContain('/repos/a%2Fb/c%20d/pulls/7/reviews');
  });

  it('answers ok without an id or address when the host succeeds without them', async () => {
    const { fetchImpl } = host(new Response('not json', { status: 200 }));
    expect(await postReview(TARGET, REPO, 7, input(), { fetchImpl })).toEqual({
      id: null,
      type: 'ok',
      url: null,
    });
  });

  it('returns no address that is not http or https', async () => {
    for (const html_url of ['javascript:alert(1)', 'data:text/html,x', 'not a url']) {
      const { fetchImpl } = host(json({ html_url, id: 3 }));
      expect(await postReview(TARGET, REPO, 7, input(), { fetchImpl })).toEqual({
        id: 3,
        type: 'ok',
        url: null,
      });
    }
  });

  it.each([
    [401, 'forbidden'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [410, 'not-found'],
    [422, 'rejected'],
    [400, 'rejected'],
    [409, 'rejected'],
    [429, 'rate-limited'],
    [500, 'unknown'],
    [502, 'unknown'],
    [503, 'unknown'],
  ] as const)('reads a %s answer as %s', async (status, reason) => {
    const { fetchImpl } = host(json({ message: 'host words' }, status));
    expect(await postReview(TARGET, REPO, 7, input(), { fetchImpl })).toEqual({
      reason,
      type: 'failed',
    });
  });

  it('reads a 403 that carries a rate-limit signal as rate limiting', async () => {
    const exhausted = host(json({}, 403, { 'x-ratelimit-remaining': '0' }));
    expect(await postReview(TARGET, REPO, 7, input(), { fetchImpl: exhausted.fetchImpl })).toEqual({
      reason: 'rate-limited',
      type: 'failed',
    });
    const told = host(json({}, 403, { 'retry-after': '30' }));
    expect(await postReview(TARGET, REPO, 7, input(), { fetchImpl: told.fetchImpl })).toEqual({
      reason: 'rate-limited',
      type: 'failed',
    });
  });

  it('says the outcome is unknown when the request fails in transit, and does not retry', async () => {
    const { fetchImpl, hits } = host(() => {
      throw new Error('socket hang up');
    });
    expect(await postReview(TARGET, REPO, 7, input(), { fetchImpl })).toEqual({
      reason: 'unknown',
      type: 'failed',
    });
    expect(hits).toHaveLength(1);
  });

  it('never puts the host’s words, the token or the request in a failure', async () => {
    const { fetchImpl } = host(json({ message: 'tok-secret echoed' }, 422));
    const result = await postReview(TARGET, REPO, 7, input(), { fetchImpl });
    expect(JSON.stringify(result)).not.toContain('tok-secret');
    expect(JSON.stringify(result)).not.toContain('echoed');
  });

  it('has a fixed message for every reason', () => {
    for (const reason of [
      'forbidden',
      'not-found',
      'rate-limited',
      'rejected',
      'unknown',
    ] as const) {
      expect(WRITE_FAILURE_MESSAGES[reason].length).toBeGreaterThan(10);
    }
    expect(WRITE_FAILURE_MESSAGES.unknown).toContain('may or may not have been sent');
  });
});

describe('postIssueComment', () => {
  it('posts the text to the conversation of the pull request', async () => {
    const { fetchImpl, hits } = host(
      json({ html_url: 'https://github.com/acme/api/pull/7#issuecomment-5', id: 5 })
    );
    const result = await postIssueComment(TARGET, REPO, 7, '/auto-swe fix', { fetchImpl });
    expect(result).toEqual({
      id: 5,
      type: 'ok',
      url: 'https://github.com/acme/api/pull/7#issuecomment-5',
    });
    expect(hits[0]?.url).toBe('https://api.github.com/repos/acme/api/issues/7/comments');
    expect(bodyOf(hits[0])).toEqual({ body: '/auto-swe fix' });
    expect(authOf(hits[0])).toBe('Bearer tok-secret');
    expect(hits[0]?.init.redirect).toBe('error');
  });

  it('reads failures the way a review does', async () => {
    const { fetchImpl } = host(json({}, 404));
    expect(await postIssueComment(TARGET, REPO, 7, 'x', { fetchImpl })).toEqual({
      reason: 'not-found',
      type: 'failed',
    });
  });
});
