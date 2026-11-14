import { describe, expect, it } from 'vitest';
import { type FindSentReviewInput, findSentReview } from './githubReviewRead.js';

const TARGET = { apiUrl: 'https://api.github.com/', token: 'tok-secret' };
const REPO = { organizationName: 'acme', repoName: 'api' };
const SHA = 'c'.repeat(40);
const NOW = new Date('2026-11-09T12:00:00Z');
const ATTEMPT = new Date('2026-11-09T11:59:00Z');

type Hit = { init: RequestInit; url: string };
type Reply = Response;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers, status });

/** A host that answers by the end of the path; a review has no comments unless a route says so. */
function host(listed: Record<string, Reply>) {
  const routes: Record<string, Reply> = { ...listed, '/comments?per_page=100': json([]) };
  const hits: Hit[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    hits.push({ init: init ?? {}, url });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    return key === undefined ? new Response('{}', { status: 404 }) : (routes[key] as Reply).clone();
  }) as typeof fetch;
  return { fetchImpl, hits };
}

const review = (over: Record<string, unknown> = {}) => ({
  body: 'Looks good',
  commit_id: SHA,
  html_url: 'https://github.com/acme/api/pull/7#pullrequestreview-9',
  id: 9,
  state: 'COMMENTED',
  submitted_at: '2026-11-09T11:59:30Z',
  user: { login: 'Reviewer' },
  ...over,
});
const input = (over: Partial<FindSentReviewInput> = {}): FindSentReviewInput => ({
  attemptedAt: ATTEMPT,
  body: 'Looks good',
  comments: [],
  event: 'COMMENT',
  headSha: SHA,
  ...over,
});
const REVIEWS = '/pulls/7/reviews?per_page=100';
const COMMENTS_9 = '/reviews/9/comments?per_page=100';
type Wanted = FindSentReviewInput['comments'][number];
const wanted = (i: number, over: Partial<Wanted> = {}): Wanted => ({
  body: `note ${i}`,
  line: 10 + i,
  path: `src/f${i}.ts`,
  side: 'RIGHT',
  startLine: null,
  ...over,
});
/** The host's spelling of a draft comment: absent side and start_line mean RIGHT and none. */
const hostComment = (w: Wanted, over: Record<string, unknown> = {}) => ({
  body: w.body,
  id: 1,
  line: w.line,
  path: w.path,
  ...(w.side === 'LEFT' ? { side: 'LEFT' } : {}),
  ...(w.startLine === null ? {} : { start_line: w.startLine }),
  ...over,
});
const comments = (ws: readonly Wanted[]) => json(ws.map((w) => hostComment(w)));
const drafts = (n: number): Wanted[] => Array.from({ length: n }, (_, i) => wanted(i));

const search = (h: ReturnType<typeof host>, over: Partial<FindSentReviewInput> = {}) =>
  findSentReview(TARGET, REPO, 7, input(over), { fetchImpl: h.fetchImpl, now: () => NOW });
const run = (routes: Record<string, Reply>, over: Partial<FindSentReviewInput> = {}) =>
  search(host({ '/user': json({ login: 'reviewer' }), ...routes }), over);

describe('findSentReview', () => {
  it('finds the reviewer’s review, ignoring the login’s case, with its address', async () => {
    const h = host({ '/user': json({ login: 'reviewer' }), [REVIEWS]: json([review()]) });
    expect(await search(h)).toEqual({
      id: 9,
      type: 'found',
      url: 'https://github.com/acme/api/pull/7#pullrequestreview-9',
    });
    expect(h.hits.map((x) => x.url)).toEqual([
      'https://api.github.com/user',
      `https://api.github.com/repos/acme/api${REVIEWS}`,
      'https://api.github.com/repos/acme/api/pulls/7/reviews/9/comments?per_page=100',
    ]);
  });

  it('only ever reads, with the token as a bearer header and redirects refused', async () => {
    const h = host({ '/user': json({ login: 'reviewer' }), [REVIEWS]: json([review()]) });
    await search(h);
    expect(h.hits.length).toBe(3);
    for (const { init, url } of h.hits) {
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('error');
      expect(init.body).toBeUndefined();
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-secret');
      expect(url).not.toContain('tok-secret');
    }
  });

  it.each([
    ['another user', { user: { login: 'someone-else' } }],
    ['no user', { user: null }],
    ['another head', { commit_id: 'd'.repeat(40) }],
    ['another state', { state: 'APPROVED' }],
    ['another body', { body: 'Something else' }],
    ['before the window', { submitted_at: '2026-11-09T11:49:00Z' }],
    ['after the window', { submitted_at: '2026-11-09T12:02:00Z' }],
    ['no time', { submitted_at: null }],
  ])('does not match a review by %s', async (_name, over) => {
    expect(await run({ [REVIEWS]: json([review(over)]) })).toEqual({ type: 'not-found' });
  });

  it('matches the body once trimmed, and a null body as empty', async () => {
    const padded = review({ body: '  Looks good \n' });
    expect((await run({ [REVIEWS]: json([padded]) })).type).toBe('found');
    const empty = review({ body: null });
    expect((await run({ [REVIEWS]: json([empty]) }, { body: '' })).type).toBe('found');
  });

  it.each([
    ['APPROVE', 'APPROVED'],
    ['REQUEST_CHANGES', 'CHANGES_REQUESTED'],
    ['COMMENT', 'COMMENTED'],
  ] as const)('maps the %s event to the %s state', async (event, state) => {
    expect((await run({ [REVIEWS]: json([review({ state })]) }, { event })).type).toBe('found');
  });

  it('accepts a review stamped just inside either edge of the window', async () => {
    for (const submitted_at of ['2026-11-09T11:50:30Z', '2026-11-09T12:01:00Z']) {
      expect((await run({ [REVIEWS]: json([review({ submitted_at })]) })).type).toBe('found');
    }
  });

  it('picks the newest of several matches', async () => {
    const result = await run({
      [REVIEWS]: json([
        review({ id: 1, submitted_at: '2026-11-09T11:59:10Z' }),
        review({ id: 2, submitted_at: '2026-11-09T11:59:50Z' }),
        review({ id: 3, submitted_at: '2026-11-09T11:59:20Z' }),
      ]),
    });
    expect(result).toMatchObject({ id: 2, type: 'found' });
  });

  it('is not-found when there is no review at all', async () => {
    expect(await run({ [REVIEWS]: json([]) })).toEqual({ type: 'not-found' });
  });

  describe('the time window treats the client clock as a hint', () => {
    it('finds a review when the browser clock is five minutes fast and the check is late', async () => {
      const fast = new Date(NOW.getTime() + 5 * 60_000);
      const submitted_at = new Date(NOW.getTime() - 3 * 60_000).toISOString();
      const result = await run(
        { [REVIEWS]: json([review({ submitted_at })]) },
        { attemptedAt: fast }
      );
      expect(result.type).toBe('found');
    });

    it('reaches back at least as far as an older claimed attempt', async () => {
      const claimed = new Date(NOW.getTime() - 30 * 60_000);
      const inside = new Date(claimed.getTime() - 60_000).toISOString();
      const outside = new Date(claimed.getTime() - 3 * 60_000).toISOString();
      const ok = await run(
        { [REVIEWS]: json([review({ submitted_at: inside })]) },
        { attemptedAt: claimed }
      );
      expect(ok.type).toBe('found');
      const miss = await run(
        { [REVIEWS]: json([review({ submitted_at: outside })]) },
        { attemptedAt: claimed }
      );
      expect(miss).toEqual({ type: 'not-found' });
    });

    it('does not match a review stamped 11 minutes ago when the claimed attempt is now', async () => {
      const submitted_at = new Date(NOW.getTime() - 11 * 60_000).toISOString();
      const result = await run(
        { [REVIEWS]: json([review({ submitted_at })]) },
        { attemptedAt: NOW }
      );
      expect(result).toEqual({ type: 'not-found' });
    });
  });

  describe('line comments', () => {
    it('matches when the comments are exactly the drafts, in any order', async () => {
      const d = drafts(3);
      const result = await run(
        {
          [REVIEWS]: json([review()]),
          [COMMENTS_9]: comments([d[2] as Wanted, d[0] as Wanted, d[1] as Wanted]),
        },
        { comments: d }
      );
      expect(result).toMatchObject({ id: 9, type: 'found' });
    });

    it('is not-found when the count differs', async () => {
      expect(
        await run(
          { [REVIEWS]: json([review()]), [COMMENTS_9]: comments(drafts(1)) },
          { comments: drafts(2) }
        )
      ).toEqual({ type: 'not-found' });
    });

    it('is not-found when one comment body differs', async () => {
      const d = drafts(2);
      const other = { ...(d[1] as Wanted), body: 'a reply typed in the UI' };
      expect(
        await run(
          { [REVIEWS]: json([review()]), [COMMENTS_9]: comments([d[0] as Wanted, other]) },
          { comments: d }
        )
      ).toEqual({ type: 'not-found' });
    });

    it('matches on trimmed bodies', async () => {
      const d = [wanted(0)];
      const padded = json([hostComment(wanted(0), { body: ' note 0\n' })]);
      expect(
        (await run({ [REVIEWS]: json([review()]), [COMMENTS_9]: padded }, { comments: d })).type
      ).toBe('found');
    });

    it('matches an outdated range comment on its original numbering', async () => {
      const d = [wanted(0, { line: 10, startLine: 8 })];
      const outdated = json([
        {
          body: 'note 0',
          line: null,
          original_line: 10,
          original_start_line: 8,
          path: 'src/f0.ts',
          start_line: null,
        },
      ]);
      expect(
        (await run({ [REVIEWS]: json([review()]), [COMMENTS_9]: outdated }, { comments: d })).type
      ).toBe('found');
    });

    it('matches a comment a later push shifted, by where it was sent', async () => {
      const d = [wanted(0, { line: 10 })];
      const shifted = json([hostComment(wanted(0, { line: 10 }), { line: 14, original_line: 10 })]);
      expect(
        (await run({ [REVIEWS]: json([review()]), [COMMENTS_9]: shifted }, { comments: d })).type
      ).toBe('found');
    });

    it('does not match a comment whose original line differs from the draft', async () => {
      const d = [wanted(0, { line: 10 })];
      const other = json([hostComment(wanted(0, { line: 10 }), { line: 10, original_line: 12 })]);
      expect(
        await run({ [REVIEWS]: json([review()]), [COMMENTS_9]: other }, { comments: d })
      ).toEqual({ type: 'not-found' });
    });

    it('treats a comments page with a next page as a miss', async () => {
      const d = drafts(1);
      const link = '<https://api.github.com/x?per_page=100&page=2>; rel="next"';
      const paged = json(
        d.map((w) => hostComment(w)),
        200,
        { link }
      );
      expect(
        await run({ [REVIEWS]: json([review()]), [COMMENTS_9]: paged }, { comments: d })
      ).toEqual({ type: 'not-found' });
    });

    it('matches range and LEFT comments on startLine and side', async () => {
      const d = [wanted(0, { side: 'LEFT' }), wanted(1, { line: 20, startLine: 15 })];
      const routes = { [REVIEWS]: json([review()]), [COMMENTS_9]: comments(d) };
      expect((await run(routes, { comments: d })).type).toBe('found');
      const wrongSide = [wanted(0), d[1] as Wanted];
      expect(await run(routes, { comments: wrongSide })).toEqual({ type: 'not-found' });
      const wrongStart = [d[0] as Wanted, wanted(1, { line: 20, startLine: 16 })];
      expect(await run(routes, { comments: wrongStart })).toEqual({ type: 'not-found' });
      const noStart = [d[0] as Wanted, wanted(1, { line: 20 })];
      expect(await run(routes, { comments: noStart })).toEqual({ type: 'not-found' });
    });

    it('does not let one comment satisfy two identical drafts', async () => {
      const d = [wanted(0), wanted(0)];
      expect(
        await run(
          { [REVIEWS]: json([review()]), [COMMENTS_9]: comments([wanted(0), wanted(1)]) },
          { comments: d }
        )
      ).toEqual({ type: 'not-found' });
    });

    it('rejects a UI thread reply (empty body, one comment) for an empty-body draft review', async () => {
      const d = [wanted(0, { body: '' })];
      const reply = json([hostComment(wanted(0, { body: 'sounds right to me' }))]);
      expect(
        await run(
          { [REVIEWS]: json([review({ body: '' })]), [COMMENTS_9]: reply },
          { body: '', comments: d }
        )
      ).toEqual({ type: 'not-found' });
    });

    it('requires zero comments when there were no drafts', async () => {
      const withOne = comments(drafts(1));
      expect(
        await run({ [REVIEWS]: json([review()]), [COMMENTS_9]: withOne }, { comments: [] })
      ).toEqual({ type: 'not-found' });
      expect(
        (await run({ [REVIEWS]: json([review()]), [COMMENTS_9]: json([]) }, { comments: [] })).type
      ).toBe('found');
    });

    it('tries the next newest candidate when the newest fails the comment check', async () => {
      const d = drafts(1);
      const h = host({
        '/user': json({ login: 'reviewer' }),
        [REVIEWS]: json([
          review({ id: 1, submitted_at: '2026-11-09T11:59:10Z' }),
          review({ id: 2, submitted_at: '2026-11-09T11:59:50Z' }),
        ]),
        '/reviews/1/comments?per_page=100': comments(d),
        '/reviews/2/comments?per_page=100': json([hostComment(wanted(7))]),
      });
      expect(await search(h, { comments: d })).toMatchObject({ id: 1, type: 'found' });
      expect(h.hits.filter((x) => x.url.includes('/comments')).length).toBe(2);
    });

    it('reads comments for at most three candidates', async () => {
      const h = host({
        '/user': json({ login: 'reviewer' }),
        [REVIEWS]: json(
          [1, 2, 3, 4, 5].map((id) =>
            review({ id, submitted_at: `2026-11-09T11:59:${String(10 + id).padStart(2, '0')}Z` })
          )
        ),
        '/comments?per_page=100': json([hostComment(wanted(7))]),
      });
      expect(await search(h, { comments: drafts(1) })).toEqual({ type: 'not-found' });
      expect(h.hits.filter((x) => x.url.includes('/comments')).length).toBe(3);
    });

    it('reads comments only for the newest candidate when it matches', async () => {
      const d = drafts(1);
      const h = host({
        '/user': json({ login: 'reviewer' }),
        [REVIEWS]: json([
          review({ id: 1, submitted_at: '2026-11-09T11:59:10Z' }),
          review({ id: 2, submitted_at: '2026-11-09T11:59:50Z' }),
        ]),
        '/reviews/2/comments?per_page=100': comments(d),
      });
      await search(h, { comments: d });
      expect(h.hits.filter((x) => x.url.includes('/comments')).map((x) => x.url)).toEqual([
        'https://api.github.com/repos/acme/api/pulls/7/reviews/2/comments?per_page=100',
      ]);
    });

    it('maps a failed comments read like any other', async () => {
      expect(
        await run(
          { [REVIEWS]: json([review()]), [COMMENTS_9]: json({}, 502) },
          { comments: drafts(1) }
        )
      ).toEqual({ reason: 'unknown', type: 'failed' });
    });
  });

  describe('paging', () => {
    const linkTo = (last: number) =>
      '<https://api.github.com/repos/acme/api/pulls/7/reviews?per_page=100&page=2>; rel="next", ' +
      `<https://api.github.com/repos/acme/api/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`;

    it('also reads the page before the last when the host says there are more', async () => {
      const h = host({
        '/user': json({ login: 'reviewer' }),
        [REVIEWS]: json([], 200, { link: linkTo(3) }),
        '/reviews?per_page=100&page=2': json([review()]),
        '/reviews?per_page=100&page=3': json([]),
      });
      expect(await search(h)).toMatchObject({ id: 9, type: 'found' });
      const pages = h.hits.filter((x) => x.url.includes('/reviews')).map((x) => x.url);
      expect(pages.some((u) => u.endsWith('page=3'))).toBe(true);
      expect(pages.some((u) => u.endsWith('page=2'))).toBe(true);
    });

    it('does not read the first page twice when the last page is the second', async () => {
      const h = host({
        '/user': json({ login: 'reviewer' }),
        [REVIEWS]: json([review({ id: 4 })], 200, { link: linkTo(2) }),
        '/reviews?per_page=100&page=2': json([]),
      });
      expect(await search(h)).toMatchObject({ id: 4, type: 'found' });
      expect(h.hits.filter((x) => x.url.includes('/pulls/7/reviews?')).length).toBe(2);
    });

    it('reads one page when the last page is the first', async () => {
      const link = '<https://api.github.com/x?per_page=100&page=1>; rel="last"';
      const h = host({
        '/user': json({ login: 'reviewer' }),
        [REVIEWS]: json([], 200, { link }),
      });
      await search(h);
      expect(h.hits.length).toBe(2);
    });
  });

  describe('rows the host sends oddly', () => {
    it('finds a valid review beside one whose commit_id is null', async () => {
      const result = await run({
        [REVIEWS]: json([review({ commit_id: null, id: 5 }), review({ id: 6 })]),
      });
      expect(result).toMatchObject({ id: 6, type: 'found' });
    });

    it('is not-found, not failed, when every row is garbage', async () => {
      expect(await run({ [REVIEWS]: json([{ id: 'x' }, 7, null, 'text']) })).toEqual({
        type: 'not-found',
      });
    });
  });

  describe('failures', () => {
    it.each([
      [401, {}, 'forbidden'],
      [403, {}, 'forbidden'],
      [403, { 'x-ratelimit-remaining': '0' }, 'rate-limited'],
      [403, { 'retry-after': '30' }, 'rate-limited'],
      [404, {}, 'not-found'],
      [410, {}, 'not-found'],
      [429, {}, 'rate-limited'],
      [500, {}, 'unknown'],
      [503, {}, 'unknown'],
      [422, {}, 'rejected'],
    ] as const)('maps %s %j on the reviews read to %s', async (status, headers, reason) => {
      expect(await run({ [REVIEWS]: json({}, status, { ...headers }) })).toEqual({
        reason,
        type: 'failed',
      });
    });

    it('maps a failed login read the same way, before reading reviews', async () => {
      const h = host({ '/user': json({}, 401) });
      expect(await search(h)).toEqual({ reason: 'forbidden', type: 'failed' });
      expect(h.hits.length).toBe(1);
    });

    it('is unknown when the connection throws', async () => {
      const fetchImpl = (async () => {
        throw new Error('socket hang up tok-secret');
      }) as typeof fetch;
      const result = await findSentReview(TARGET, REPO, 7, input(), { fetchImpl });
      expect(result).toEqual({ reason: 'unknown', type: 'failed' });
    });

    it('is unknown when an answer does not parse', async () => {
      const unknown = { reason: 'unknown', type: 'failed' };
      expect(await run({ [REVIEWS]: json({ not: 'a list' }) })).toEqual(unknown);
      expect(await run({ [REVIEWS]: new Response('nope') })).toEqual(unknown);
      expect(await run({ '/user': json({ login: '' }), [REVIEWS]: json([]) })).toEqual(unknown);
    });
  });

  it('returns no address that is not http or https', async () => {
    const result = await run({ [REVIEWS]: json([review({ html_url: 'javascript:alert(1)' })]) });
    expect(result).toEqual({ id: 9, type: 'found', url: null });
  });

  it('puts no token, login or text in any result', async () => {
    const results = [
      await run({ [REVIEWS]: json([review()]) }),
      await run({ [REVIEWS]: json([]) }),
      await run({ [REVIEWS]: json({ message: 'tok-secret Looks good reviewer' }, 500) }),
    ];
    for (const r of results) {
      const text = JSON.stringify(r);
      expect(text).not.toContain('tok-secret');
      expect(text).not.toContain('Looks good');
      expect(text).not.toContain('reviewer');
    }
  });
});
