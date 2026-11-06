import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  credential: vi.fn(),
  hosts: vi.fn(),
  token: vi.fn(),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({ resolveGitHubConfig: async () => ({}) }));
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  repositoryHostsAllowed: m.hosts,
}));
vi.mock('@auto-swe/shared/lib/githubHostCredential', () => ({
  resolvePlatformCredential: m.credential,
}));
vi.mock('@auto-swe/shared/lib/githubHostScope', () => ({
  hostFamily: (url: string) => new URL(url).hostname,
  installationTargetFor: (_repo: unknown, config: { apiUrl: string }) => ({
    apiUrl: config.apiUrl,
  }),
}));
vi.mock('@auto-swe/shared/lib/githubInstallation', () => ({ resolveGitHubToken: m.token }));

import {
  type PullFilesRepo,
  readCompare,
  readPullFiles,
  resetPullFilesCache,
} from './githubPullFiles.js';

const REPO: PullFilesRepo = {
  githubApiUrl: null,
  githubUrl: null,
  id: 'conn-1',
  installation: null,
  organizationName: 'acme',
  repoName: 'api',
};
const TARGET = { apiUrl: 'https://api.github.com', token: 'tok-secret' };
const target = async () => TARGET;

type Hit = { url: string; init?: RequestInit };
const authOf = (hit: Hit | undefined): string | undefined =>
  (hit?.init?.headers as Record<string, string> | undefined)?.Authorization;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers, status });

const file = (over: Record<string, unknown> = {}) => ({
  additions: 2,
  changes: 3,
  deletions: 1,
  filename: 'src/a.ts',
  patch: '@@ -1 +1,2 @@\n-a\n+b\n+c',
  status: 'modified',
  ...over,
});

/** A fake host: `pull` answers the pull request, `pages` the file pages in order. */
function host(
  pull: unknown | Response,
  pages: (unknown[] | Response)[] = [[file()]]
): { fetchImpl: typeof fetch; hits: Hit[] } {
  const hits: Hit[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    hits.push({ init, url });
    if (url.includes('/files?')) {
      const page = Number(new URL(url).searchParams.get('page'));
      const reply = pages[page - 1] ?? [];
      return reply instanceof Response ? reply : json(reply);
    }
    return pull instanceof Response ? pull : json(pull);
  }) as typeof fetch;
  return { fetchImpl, hits };
}

const PULL = { changed_files: 1, head: { sha: 'abc123' }, state: 'open' };

beforeEach(() => {
  resetPullFilesCache();
  m.credential.mockReset();
  m.hosts.mockReset();
  m.token.mockReset();
});

describe('readPullFiles', () => {
  it('reads the live head and maps the files, with a digest for each patch', async () => {
    const { fetchImpl, hits } = host(PULL);
    const result = await readPullFiles(REPO, 7, { fetchImpl, target });
    expect(result).toMatchObject({
      headSha: 'abc123',
      state: 'open',
      truncated: false,
      type: 'ok',
    });
    if (result.type !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: 'src/a.ts', status: 'modified' });
    expect(result.files[0]?.patchDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(hits[0]?.url).toBe('https://api.github.com/repos/acme/api/pulls/7');
    expect(hits[1]?.url).toContain('/repos/acme/api/pulls/7/files?per_page=100&page=1');
  });

  it('sends the token only as a bearer header and refuses redirects', async () => {
    const { fetchImpl, hits } = host(PULL);
    await readPullFiles(REPO, 7, { fetchImpl, target });
    for (const hit of hits) {
      expect(hit.init?.redirect).toBe('error');
      expect(authOf(hit)).toBe('Bearer tok-secret');
      expect(hit.url).not.toContain('tok-secret');
    }
  });

  it('maps renames, other statuses and a pure rename the way the evaluator does', async () => {
    const { fetchImpl } = host({ ...PULL, changed_files: 3 }, [
      [
        file({
          additions: 0,
          changes: 0,
          deletions: 0,
          filename: 'new.ts',
          patch: undefined,
          previous_filename: 'old.ts',
          status: 'renamed',
        }),
        file({ filename: 'c.ts', status: 'copied' }),
        file({ filename: 'gone.ts', status: 'removed' }),
      ],
    ]);
    const result = await readPullFiles(REPO, 7, { fetchImpl, target });
    if (result.type !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.files[0]).toMatchObject({
      path: 'new.ts',
      previousPath: 'old.ts',
      similarity: 100,
      status: 'renamed',
    });
    expect(result.files[0]?.patch).toBeUndefined();
    expect(result.files[0]?.patchDigest).toBeUndefined();
    expect(result.files[1]?.status).toBe('modified');
    expect(result.files[2]?.status).toBe('removed');
  });

  it('treats a patch over the cap as absent', async () => {
    const { fetchImpl } = host(PULL, [[file({ patch: 'x'.repeat(200_001) })]]);
    const result = await readPullFiles(REPO, 7, { fetchImpl, target });
    if (result.type !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.files[0]?.patch).toBeUndefined();
  });

  it('reads another page while the last one is full, and stops at a short one', async () => {
    const full = Array.from({ length: 100 }, (_, i) => file({ filename: `f${i}.ts` }));
    const { fetchImpl, hits } = host({ ...PULL, changed_files: 101 }, [full, [file()]]);
    const result = await readPullFiles(REPO, 7, { fetchImpl, target });
    if (result.type !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.files).toHaveLength(101);
    expect(result.truncated).toBe(false);
    expect(hits.filter((h) => h.url.includes('/files?'))).toHaveLength(2);
  });

  it('says so when the host lists more files than were read', async () => {
    const { fetchImpl } = host({ ...PULL, changed_files: 4000 }, [[file()]]);
    const result = await readPullFiles(REPO, 7, { fetchImpl, target });
    expect(result).toMatchObject({ truncated: true, type: 'ok' });
  });

  it.each([
    ['a 404', json({}, 404), 'not-found'],
    ['a 410', json({}, 410), 'not-found'],
    ['a 429', json({}, 429), 'rate-limited'],
    ['an exhausted 403', json({}, 403, { 'x-ratelimit-remaining': '0' }), 'rate-limited'],
    ['a 403 with retry-after', json({}, 403, { 'retry-after': '30' }), 'rate-limited'],
    ['a refused 403', json({}, 403), 'failed'],
    ['a 500', json({}, 500), 'failed'],
    ['an unreadable pull request', json({ nope: true }), 'failed'],
  ])('reports %s on the pull request as unavailable: %s', async (_name, reply, reason) => {
    const { fetchImpl } = host(reply);
    expect(await readPullFiles(REPO, 7, { fetchImpl, target })).toEqual({
      reason,
      type: 'unavailable',
    });
  });

  it('reports a failing file page, an unreadable one and a network error as unavailable', async () => {
    expect(
      await readPullFiles(REPO, 7, {
        fetchImpl: host(PULL, [json({}, 500)]).fetchImpl,
        target,
      })
    ).toEqual({ reason: 'failed', type: 'unavailable' });
    expect(
      await readPullFiles(REPO, 7, {
        fetchImpl: host(PULL, [json({ not: 'a list' })]).fetchImpl,
        target,
      })
    ).toEqual({ reason: 'failed', type: 'unavailable' });
    const throwing = (async () => {
      throw new Error('socket hang up with tok-secret in it');
    }) as typeof fetch;
    const result = await readPullFiles(REPO, 7, { fetchImpl: throwing, target });
    expect(result).toEqual({ reason: 'failed', type: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('tok-secret');
  });

  it('has nothing to read for a repository with no owner or name', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(
      await readPullFiles({ ...REPO, organizationName: null }, 7, { fetchImpl, target })
    ).toEqual({ reason: 'not-found', type: 'unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('encodes the owner and repository in the path', async () => {
    const { fetchImpl, hits } = host(PULL);
    await readPullFiles({ ...REPO, organizationName: 'a/b', repoName: 'c d' }, 7, {
      fetchImpl,
      target,
    });
    expect(hits[0]?.url).toContain('/repos/a%2Fb/c%20d/pulls/7');
  });

  describe('the cache', () => {
    it('reads the files once for one head, and again when the head moves', async () => {
      const first = host(PULL);
      await readPullFiles(REPO, 7, { fetchImpl: first.fetchImpl, target });
      await readPullFiles(REPO, 7, { fetchImpl: first.fetchImpl, target });
      expect(first.hits.filter((h) => h.url.includes('/files?'))).toHaveLength(1);
      // The pull request itself is always read: it is how the live head is known.
      expect(first.hits.filter((h) => !h.url.includes('/files?'))).toHaveLength(2);

      const moved = host({ ...PULL, head: { sha: 'def456' } });
      await readPullFiles(REPO, 7, { fetchImpl: moved.fetchImpl, target });
      expect(moved.hits.filter((h) => h.url.includes('/files?'))).toHaveLength(1);
    });

    it('keeps one entry per repository connection', async () => {
      const first = host(PULL);
      await readPullFiles(REPO, 7, { fetchImpl: first.fetchImpl, target });
      const other = host(PULL);
      await readPullFiles({ ...REPO, id: 'conn-2' }, 7, { fetchImpl: other.fetchImpl, target });
      expect(other.hits.filter((h) => h.url.includes('/files?'))).toHaveLength(1);
    });

    it('does not keep a failed read', async () => {
      const failing = host(PULL, [json({}, 500)]);
      await readPullFiles(REPO, 7, { fetchImpl: failing.fetchImpl, target });
      await Promise.resolve();
      const ok = host(PULL);
      await readPullFiles(REPO, 7, { fetchImpl: ok.fetchImpl, target });
      expect(ok.hits.filter((h) => h.url.includes('/files?'))).toHaveLength(1);
    });

    it('forgets an entry once it is older than the lifetime', async () => {
      let now = 1_000;
      const first = host(PULL);
      await readPullFiles(REPO, 7, { fetchImpl: first.fetchImpl, now: () => now, target });
      now += 5 * 60_000 + 1;
      await readPullFiles(REPO, 7, { fetchImpl: first.fetchImpl, now: () => now, target });
      expect(first.hits.filter((h) => h.url.includes('/files?'))).toHaveLength(2);
    });

    it('does not keep a read whose patches are very large', async () => {
      const big = Array.from({ length: 30 }, (_, i) =>
        file({ filename: `f${i}.ts`, patch: 'x'.repeat(190_000) })
      );
      const first = host({ ...PULL, changed_files: 30 }, [big]);
      await readPullFiles(REPO, 7, { fetchImpl: first.fetchImpl, target });
      await Promise.resolve();
      const again = host({ ...PULL, changed_files: 30 }, [big]);
      await readPullFiles(REPO, 7, { fetchImpl: again.fetchImpl, target });
      expect(again.hits.filter((h) => h.url.includes('/files?'))).toHaveLength(1);
    });
  });

  describe('the credential', () => {
    const usable = () => {
      m.hosts.mockResolvedValue({ ok: true });
      m.credential.mockResolvedValue({
        config: { apiUrl: 'https://ghe.example.com/api/v3' },
        scope: 'host',
      });
      m.token.mockResolvedValue('ghe-token');
    };

    it('uses the platform credential of the repository host', async () => {
      usable();
      const { fetchImpl, hits } = host(PULL);
      const result = await readPullFiles(REPO, 7, { fetchImpl });
      expect(result.type).toBe('ok');
      expect(hits[0]?.url.startsWith('https://ghe.example.com/api/v3/repos/acme/api')).toBe(true);
      expect(authOf(hits[0])).toBe('Bearer ghe-token');
    });

    it('sends nothing when the repository host is not approved', async () => {
      m.hosts.mockResolvedValue({ ok: false, url: 'https://evil.example.com' });
      const { fetchImpl, hits } = host(PULL);
      expect(await readPullFiles(REPO, 7, { fetchImpl })).toEqual({
        reason: 'host-not-approved',
        type: 'unavailable',
      });
      expect(hits).toHaveLength(0);
      expect(m.token).not.toHaveBeenCalled();
    });

    it.each(['mismatch', 'misconfigured', 'installation-mismatch'])(
      'sends nothing when the credential scope is %s',
      async (scope) => {
        m.hosts.mockResolvedValue({ ok: true });
        m.credential.mockResolvedValue({ config: { apiUrl: 'https://x' }, scope });
        const { fetchImpl, hits } = host(PULL);
        expect(await readPullFiles(REPO, 7, { fetchImpl })).toEqual({
          reason: 'no-credential',
          type: 'unavailable',
        });
        expect(hits).toHaveLength(0);
        expect(m.token).not.toHaveBeenCalled();
      }
    );

    it('answers no credential when minting a token throws', async () => {
      usable();
      m.token.mockRejectedValue(new Error('bad key'));
      const { fetchImpl, hits } = host(PULL);
      expect(await readPullFiles(REPO, 7, { fetchImpl })).toEqual({
        reason: 'no-credential',
        type: 'unavailable',
      });
      expect(hits).toHaveLength(0);
    });
  });
});

describe('reading economically', () => {
  const etagged = (body: unknown, etag: string) => json(body, 200, { etag });
  const unchanged = () => new Response(null, { status: 304 });

  /** A host whose answers to the pull request come from a script, one per call. */
  function scripted(pulls: Response[], pages: (unknown[] | Response)[] = [[file()]]) {
    const hits: Hit[] = [];
    let call = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      hits.push({ init, url });
      if (url.includes('/files?')) {
        const reply = pages[Number(new URL(url).searchParams.get('page')) - 1] ?? [];
        return reply instanceof Response ? reply : json(reply);
      }
      const next = pulls[Math.min(call, pulls.length - 1)];
      call += 1;
      return next ?? json(PULL);
    }) as typeof fetch;
    return { fetchImpl, hits };
  }
  const conditional = (hit: Hit | undefined): string | undefined =>
    (hit?.init?.headers as Record<string, string> | undefined)?.['If-None-Match'];
  const pullHits = (hits: Hit[]) => hits.filter((h) => !h.url.includes('/files?'));
  const fileHits = (hits: Hit[]) => hits.filter((h) => h.url.includes('/files?'));

  it('asks with the ETag it was given, and a 304 reuses the facts and the cached files', async () => {
    const { fetchImpl, hits } = scripted([etagged(PULL, '"v1"'), unchanged()]);
    const first = await readPullFiles(REPO, 7, { fetchImpl, target });
    const second = await readPullFiles(REPO, 7, { fetchImpl, target });
    expect(conditional(pullHits(hits)[0])).toBeUndefined();
    expect(conditional(pullHits(hits)[1])).toBe('"v1"');
    expect(second).toMatchObject({ headSha: 'abc123', state: 'open', type: 'ok' });
    expect(second).toEqual(first);
    expect(fileHits(hits)).toHaveLength(1);
  });

  it('sends no condition when the host gave no ETag', async () => {
    const { fetchImpl, hits } = scripted([json(PULL), json(PULL)]);
    await readPullFiles(REPO, 7, { fetchImpl, target });
    await readPullFiles(REPO, 7, { fetchImpl, target });
    expect(pullHits(hits).map(conditional)).toEqual([undefined, undefined]);
  });

  it('keeps an ETag per repository and pull request', async () => {
    const { fetchImpl, hits } = scripted([etagged(PULL, '"v1"'), json(PULL), json(PULL)]);
    await readPullFiles(REPO, 7, { fetchImpl, target });
    await readPullFiles({ ...REPO, id: 'conn-2' }, 7, { fetchImpl, target });
    await readPullFiles(REPO, 8, { fetchImpl, target });
    expect(pullHits(hits).map(conditional)).toEqual([undefined, undefined, undefined]);
  });

  it('forgets an ETag when the next answer carries none', async () => {
    const { fetchImpl, hits } = scripted([etagged(PULL, '"v1"'), json(PULL), json(PULL)]);
    for (let i = 0; i < 3; i++) {
      await readPullFiles(REPO, 7, { fetchImpl, target });
    }
    expect(pullHits(hits).map(conditional)).toEqual([undefined, '"v1"', undefined]);
  });

  it('takes the state from the fresh read, not from the cached files', async () => {
    const closed = { ...PULL, state: 'closed' };
    const { fetchImpl, hits } = scripted([etagged(PULL, '"v1"'), etagged(closed, '"v2"')]);
    const open = await readPullFiles(REPO, 7, { fetchImpl, target });
    const now = await readPullFiles(REPO, 7, { fetchImpl, target });
    expect(open).toMatchObject({ state: 'open' });
    expect(now).toMatchObject({ headSha: 'abc123', state: 'closed', type: 'ok' });
    // Same head, so the files were not read again.
    expect(fileHits(hits)).toHaveLength(1);
  });

  it('answers a later 304 with the newest facts it holds', async () => {
    const closed = { ...PULL, state: 'closed' };
    const { fetchImpl } = scripted([etagged(PULL, '"v1"'), etagged(closed, '"v2"'), unchanged()]);
    await readPullFiles(REPO, 7, { fetchImpl, target });
    await readPullFiles(REPO, 7, { fetchImpl, target });
    expect(await readPullFiles(REPO, 7, { fetchImpl, target })).toMatchObject({ state: 'closed' });
  });

  it('treats a 304 to a read that was not conditional as the host failing', async () => {
    const { fetchImpl } = scripted([json(PULL)], [unchanged()]);
    expect(await readPullFiles(REPO, 7, { fetchImpl, target })).toEqual({
      reason: 'failed',
      type: 'unavailable',
    });
  });

  it('stops asking the host when the whole read has run out of time', async () => {
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    expect(await readPullFiles(REPO, 7, { deadlineMs: 20, fetchImpl: hanging, target })).toEqual({
      reason: 'failed',
      type: 'unavailable',
    });
  });

  it('does not drop a newer read when an older one for the same head fails late', async () => {
    let now = 1_000;
    let release: (reply: Response) => void = () => undefined;
    const slow = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let reachedFiles: () => void = () => undefined;
    const filesAsked = new Promise<void>((resolve) => {
      reachedFiles = resolve;
    });
    const older = (async (input: string | URL | Request) => {
      if (String(input).includes('/files?')) {
        reachedFiles();
        return slow;
      }
      return json(PULL);
    }) as typeof fetch;
    const first = readPullFiles(REPO, 7, { fetchImpl: older, now: () => now, target });
    await filesAsked;

    // Past the lifetime, so a second read of the same head replaces the first entry.
    now += 5 * 60_000 + 1;
    const newer = scripted([json(PULL)]);
    expect(
      (await readPullFiles(REPO, 7, { fetchImpl: newer.fetchImpl, now: () => now, target })).type
    ).toBe('ok');

    release(json({}, 500));
    expect((await first).type).toBe('unavailable');
    await Promise.resolve();

    const third = scripted([json(PULL)]);
    await readPullFiles(REPO, 7, { fetchImpl: third.fetchImpl, now: () => now, target });
    expect(fileHits(third.hits)).toHaveLength(0);
  });
});

describe('readCompare', () => {
  const BASE = 'a'.repeat(40);
  const HEAD = 'b'.repeat(40);
  const compareBody = (over: Record<string, unknown> = {}) => ({
    commits: [
      { commit: { message: 'fix: first\n\nbody text' }, sha: 'c1' },
      { commit: { message: 'second' }, sha: 'c2' },
    ],
    status: 'ahead',
    total_commits: 2,
    ...over,
  });
  const answering = (reply: Response | (() => Response)) => {
    const hits: Hit[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      hits.push({ init, url: String(input) });
      return typeof reply === 'function' ? reply() : reply.clone();
    }) as typeof fetch;
    return { fetchImpl, hits };
  };

  it('lists the commits with the first line of each message as its subject', async () => {
    const { fetchImpl, hits } = answering(json(compareBody()));
    const result = await readCompare(REPO, BASE, HEAD, { fetchImpl, target });
    expect(result).toEqual({
      commits: [
        { sha: 'c1', subject: 'fix: first' },
        { sha: 'c2', subject: 'second' },
      ],
      rewritten: false,
      totalCommits: 2,
      type: 'ok',
    });
    expect(hits[0]?.url).toBe(
      `https://api.github.com/repos/acme/api/compare/${BASE}...${HEAD}?per_page=100`
    );
    expect(authOf(hits[0])).toBe('Bearer tok-secret');
    expect(hits[0]?.init?.redirect).toBe('error');
  });

  it('reads a diverged or backwards head as a rewritten branch', async () => {
    for (const status of ['diverged', 'behind']) {
      resetPullFilesCache();
      const { fetchImpl } = answering(json(compareBody({ status })));
      const result = await readCompare(REPO, BASE, HEAD, { fetchImpl, target });
      expect(result).toMatchObject({ rewritten: true, type: 'ok' });
    }
  });

  it('reads a base the host no longer knows as a rewritten branch with no commits', async () => {
    const { fetchImpl } = answering(json({}, 404));
    expect(await readCompare(REPO, BASE, HEAD, { fetchImpl, target })).toEqual({
      commits: [],
      rewritten: true,
      totalCommits: 0,
      type: 'ok',
    });
  });

  it('says how many commits there are beyond the ones listed', async () => {
    const { fetchImpl } = answering(json(compareBody({ total_commits: 400 })));
    const result = await readCompare(REPO, BASE, HEAD, { fetchImpl, target });
    expect(result).toMatchObject({ totalCommits: 400, type: 'ok' });
  });

  it('cuts a long subject', async () => {
    const { fetchImpl } = answering(
      json(compareBody({ commits: [{ commit: { message: 'x'.repeat(500) }, sha: 'c1' }] }))
    );
    const result = await readCompare(REPO, BASE, HEAD, { fetchImpl, target });
    expect(result.type === 'ok' && result.commits[0]?.subject).toHaveLength(200);
  });

  it('asks the host once for a pair of commits', async () => {
    const { fetchImpl, hits } = answering(json(compareBody()));
    await readCompare(REPO, BASE, HEAD, { fetchImpl, target });
    await readCompare(REPO, BASE.toUpperCase(), HEAD, { fetchImpl, target });
    expect(hits).toHaveLength(1);
  });

  it('keeps a pair per repository', async () => {
    const { fetchImpl, hits } = answering(json(compareBody()));
    await readCompare(REPO, BASE, HEAD, { fetchImpl, target });
    await readCompare({ ...REPO, id: 'conn-2' }, BASE, HEAD, { fetchImpl, target });
    expect(hits).toHaveLength(2);
  });

  it('asks again after a failure, and does not keep it', async () => {
    const failing = answering(json({}, 500));
    expect(await readCompare(REPO, BASE, HEAD, { fetchImpl: failing.fetchImpl, target })).toEqual({
      reason: 'failed',
      type: 'unavailable',
    });
    await Promise.resolve();
    const working = answering(json(compareBody()));
    const result = await readCompare(REPO, BASE, HEAD, { fetchImpl: working.fetchImpl, target });
    expect(result.type).toBe('ok');
    expect(working.hits).toHaveLength(1);
  });

  it('reports rate limiting and an unreadable answer as unavailable', async () => {
    const limited = answering(json({}, 429));
    expect(await readCompare(REPO, BASE, HEAD, { fetchImpl: limited.fetchImpl, target })).toEqual({
      reason: 'rate-limited',
      type: 'unavailable',
    });
    resetPullFilesCache();
    const odd = answering(json({ commits: 'no' }));
    expect(await readCompare(REPO, BASE, HEAD, { fetchImpl: odd.fetchImpl, target })).toEqual({
      reason: 'failed',
      type: 'unavailable',
    });
  });

  it('puts only a commit id into the path', async () => {
    const { fetchImpl, hits } = answering(json(compareBody()));
    for (const bad of ['../../x', 'main', `${BASE}/../x`, 'a'.repeat(39), '']) {
      expect(await readCompare(REPO, bad, HEAD, { fetchImpl, target })).toEqual({
        reason: 'not-found',
        type: 'unavailable',
      });
      expect(await readCompare(REPO, BASE, bad, { fetchImpl, target })).toEqual({
        reason: 'not-found',
        type: 'unavailable',
      });
    }
    expect(hits).toHaveLength(0);
  });

  it('is unavailable without a credential or on a host that is not approved', async () => {
    const { fetchImpl, hits } = answering(json(compareBody()));
    expect(await readCompare(REPO, BASE, HEAD, { fetchImpl, target: async () => null })).toEqual({
      reason: 'no-credential',
      type: 'unavailable',
    });
    expect(
      await readCompare(REPO, BASE, HEAD, { fetchImpl, target: async () => 'host-not-approved' })
    ).toEqual({ reason: 'host-not-approved', type: 'unavailable' });
    expect(hits).toHaveLength(0);
  });
});
