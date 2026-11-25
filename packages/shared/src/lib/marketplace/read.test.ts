import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type SkillSourceDeps, SkillSourceError } from '../skillSource/index.js';
import { ENTRY_REASONS, parseMarketplace } from './parse.js';
import { entryFolder, MarketplaceInvalid, readMarketplace } from './read.js';
import { treeHub } from './treeHub.testing.js';

const SHA = 'a'.repeat(40);
const blobId = (b: Buffer) =>
  createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

function hub(
  entries: Array<{ path: string; content: string; mode?: string; size?: number; id?: string }>,
  opts: { sha?: string; truncated?: boolean } = {}
) {
  const blobs = new Map<string, Buffer>();
  const tree = entries.map((e) => {
    const b = Buffer.from(e.content);
    const id = e.id ?? blobId(b);
    blobs.set(id, b);
    return {
      mode: e.mode ?? '100644',
      path: e.path,
      sha: id,
      size: e.size ?? b.length,
      type: 'blob',
    };
  });
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.includes('/commits/')) {
      return ok({ sha: opts.sha ?? SHA });
    }
    if (u.includes('/git/trees/')) {
      return ok({ tree, truncated: opts.truncated ?? false });
    }
    const m = /\/git\/blobs\/([0-9a-f]+)/.exec(u);
    const b = m ? blobs.get(m[1] as string) : undefined;
    return b
      ? ok({ content: b.toString('base64'), encoding: 'base64' })
      : new Response('{}', { status: 404 });
  });
  return fetchFn;
}

const deps = (f: ReturnType<typeof hub>): SkillSourceDeps => ({
  approvedHosts: async () => [],
  fetch: f as unknown as typeof fetch,
  githubConfig: (async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  })) as unknown as SkillSourceDeps['githubConfig'],
  githubToken: (async () => 't') as SkillSourceDeps['githubToken'],
  platformCredential: (async () => ({
    scope: 'none',
  })) as unknown as SkillSourceDeps['platformCredential'],
  privateNetworkHosts: async () => [],
});

const loc = { host: 'github.com', owner: 'Acme', path: '', ref: 'main', repo: 'Market' };
const CATALOG = JSON.stringify({ name: 'm', plugins: [{ name: 'a', source: './plugins/a' }] });

describe('readMarketplace', () => {
  it('reads the catalog in three requests and normalises the location', async () => {
    const f = hub([{ content: CATALOG, path: '.claude-plugin/marketplace.json' }]);
    const r = await readMarketplace(loc, {}, deps(f));
    expect(r.sha).toBe(SHA);
    expect(r.location.owner).toBe('acme');
    expect(r.marketplace.entries[0]?.name).toBe('a');
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('reads the file under the path', async () => {
    const f = hub([
      { content: 'x', path: '.claude-plugin/marketplace.json' },
      { content: CATALOG, path: 'sub/.claude-plugin/marketplace.json' },
    ]);
    const r = await readMarketplace({ ...loc, path: 'sub' }, {}, deps(f));
    expect(r.marketplace.name).toBe('m');
  });

  it('reads an exact commit without resolving the ref', async () => {
    const f = hub([{ content: CATALOG, path: '.claude-plugin/marketplace.json' }]);
    await readMarketplace(loc, { atSha: 'b'.repeat(40) }, deps(f));
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls.some((c) => String(c[0]).includes('/commits/'))).toBe(false);
  });

  it('fails SHA_MOVED when the ref no longer resolves to the expected commit', async () => {
    const f = hub([{ content: CATALOG, path: '.claude-plugin/marketplace.json' }], {
      sha: 'b'.repeat(40),
    });
    await expect(readMarketplace(loc, { expectSha: SHA }, deps(f))).rejects.toMatchObject({
      code: 'SHA_MOVED',
    });
  });

  it('reports a missing file, a symlink and invalid content as MarketplaceInvalid', async () => {
    await expect(readMarketplace(loc, {}, deps(hub([])))).rejects.toBeInstanceOf(
      MarketplaceInvalid
    );
    await expect(
      readMarketplace(
        loc,
        {},
        deps(hub([{ content: 'target', mode: '120000', path: '.claude-plugin/marketplace.json' }]))
      )
    ).rejects.toBeInstanceOf(MarketplaceInvalid);
    await expect(
      readMarketplace(
        loc,
        {},
        deps(hub([{ content: '{"name":1}', path: '.claude-plugin/marketplace.json' }]))
      )
    ).rejects.toBeInstanceOf(MarketplaceInvalid);
  });

  it('refuses a blob whose content or size does not match the listing', async () => {
    await expect(
      readMarketplace(
        loc,
        {},
        deps(
          hub([{ content: CATALOG, id: 'e'.repeat(40), path: '.claude-plugin/marketplace.json' }])
        )
      )
    ).rejects.toBeInstanceOf(SkillSourceError);
  });

  it('refuses a truncated tree and an oversized file before downloading it', async () => {
    await expect(
      readMarketplace(
        loc,
        {},
        deps(
          hub([{ content: CATALOG, path: '.claude-plugin/marketplace.json' }], { truncated: true })
        )
      )
    ).rejects.toMatchObject({ code: 'TREE_TRUNCATED' });
    const f = hub([{ content: CATALOG, path: '.claude-plugin/marketplace.json', size: 2_000_000 }]);
    await expect(readMarketplace(loc, {}, deps(f))).rejects.toBeInstanceOf(MarketplaceInvalid);
    expect(f.mock.calls.some((c) => String(c[0]).includes('/git/blobs/'))).toBe(false);
  });

  it('refuses a host that is not approved before any request', async () => {
    const f = hub([]);
    await expect(
      readMarketplace({ ...loc, host: 'ghe.example.com' }, {}, deps(f))
    ).rejects.toMatchObject({
      code: 'HOST_NOT_APPROVED',
    });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('entryFolder', () => {
  const parsed = (plugins: unknown[]) => {
    const r = parseMarketplace(Buffer.from(JSON.stringify({ name: 'm', plugins })));
    if (!r.ok) {
      throw new Error('bad');
    }
    return r.marketplace.entries;
  };
  const market = { host: 'github.com', owner: 'acme', path: 'mk', ref: 'main', repo: 'market' };

  it('places a relative entry under the marketplace folder at the marketplace commit', () => {
    const [e] = parsed([{ name: 'a', source: './plugins/a' }]);
    expect(entryFolder(market, e as never, SHA)).toEqual({
      fixedSha: SHA,
      location: { ...market, path: 'mk/plugins/a' },
    });
  });

  it('places a GitHub entry in its own repository, fixed only when it names a commit', () => {
    const [a, b] = parsed([
      { name: 'a', source: { ref: 'v1', repo: 'x/y', source: 'github' } },
      { name: 'b', source: { repo: 'x/z', sha: 'd'.repeat(40), source: 'github' } },
    ]);
    expect(entryFolder(market, a as never, SHA)).toEqual({
      fixedSha: null,
      location: { host: 'github.com', owner: 'x', path: '', ref: 'v1', repo: 'y' },
    });
    expect(entryFolder(market, b as never, SHA).fixedSha).toBe('d'.repeat(40));
  });

  it('throws for an entry that is not installable', () => {
    const [e] = parsed([{ name: 'a', source: 'https://x/y.git' }]);
    expect(() => entryFolder(market, e as never, SHA)).toThrow(MarketplaceInvalid);
  });
});

describe('readMarketplace on a repository whose recursive tree is truncated', () => {
  const files = [
    { content: 'x'.repeat(10), path: 'README.md' },
    { content: 'y', path: 'plugins/a/commands/hi.md' },
    { content: CATALOG, path: '.claude-plugin/marketplace.json' },
    { content: CATALOG, path: 'sub/.claude-plugin/marketplace.json' },
    { content: 'z', path: 'sub/other/file.md' },
  ];
  const truncatedRoot = (dir: string, recursive: boolean) => dir === '' && recursive;
  const depsOf = (h: { fetchFn: typeof fetch }, over: Partial<SkillSourceDeps> = {}) => ({
    ...deps(hub([])),
    fetch: h.fetchFn,
    ...over,
  });

  it('lists only the directories on the way to the catalog', async () => {
    const h = treeHub(files, { commit: SHA, truncated: truncatedRoot });
    const r = await readMarketplace(loc, {}, depsOf(h));
    expect(r.marketplace.name).toBe('m');
    // ref, recursive root (truncated), root, `.claude-plugin` (whole), the blob
    expect(h.mock).toHaveBeenCalledTimes(5);
    expect(h.urls.some((u) => u.includes('/plugins'))).toBe(false);
  });

  it('walks down to a catalog under a path', async () => {
    const h = treeHub(files, { commit: SHA, truncated: truncatedRoot });
    const r = await readMarketplace({ ...loc, path: 'sub' }, {}, depsOf(h));
    expect(r.marketplace.name).toBe('m');
    expect(r.location.path).toBe('sub');
  });

  it('lists a truncated catalog directory one level at a time', async () => {
    const h = treeHub(files, {
      commit: SHA,
      truncated: (dir, recursive) => (dir === '' || dir === '.claude-plugin') && recursive,
    });
    const r = await readMarketplace(loc, {}, depsOf(h));
    expect(r.marketplace.name).toBe('m');
  });

  it('treats a missing directory as a missing catalog', async () => {
    const h = treeHub(files, { commit: SHA, truncated: truncatedRoot });
    await expect(readMarketplace({ ...loc, path: 'nope' }, {}, depsOf(h))).rejects.toBeInstanceOf(
      MarketplaceInvalid
    );
  });

  it('refuses when a directory it needs cannot be listed whole', async () => {
    const h = treeHub(files, { commit: SHA, truncated: (dir) => dir === '' });
    await expect(readMarketplace(loc, {}, depsOf(h))).rejects.toMatchObject({
      code: 'TREE_TRUNCATED',
    });
    const h2 = treeHub(files, {
      commit: SHA,
      truncated: (dir) => dir === '' || dir === '.claude-plugin',
    });
    await expect(readMarketplace(loc, {}, depsOf(h2))).rejects.toMatchObject({
      code: 'TREE_TRUNCATED',
    });
  });

  it('stays inside the request budget', async () => {
    const h = treeHub(files, { commit: SHA, truncated: truncatedRoot });
    await expect(
      readMarketplace(loc, {}, depsOf(h, { limits: { maxRequests: 3 } }))
    ).rejects.toMatchObject({ code: 'LIMIT_REQUESTS' });
  });

  it('keeps the size and object id checks on the fallback path', async () => {
    const h = treeHub(files, { commit: SHA, truncated: truncatedRoot });
    const bad = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const res = await (h.fetchFn as unknown as (u: unknown, i?: unknown) => Promise<Response>)(
        url,
        init
      );
      if (String(url).includes('/git/blobs/')) {
        return new Response(
          JSON.stringify({
            content: Buffer.from('tampered').toString('base64'),
            encoding: 'base64',
          }),
          { status: 200 }
        );
      }
      return res;
    });
    await expect(
      readMarketplace(loc, {}, depsOf(h, { fetch: bad as unknown as typeof fetch }))
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});

describe('entry source hosts', () => {
  const GHE = 'ghe.example.com';
  const catalog = (plugins: unknown[]) => JSON.stringify({ name: 'm', plugins });
  const gh = (extra: Record<string, unknown> = {}) => ({
    name: 'x',
    source: { repo: 'a/b', source: 'github', ...extra },
  });
  const read = async (
    market: string,
    plugins: unknown[],
    approved: string[],
    over: Partial<SkillSourceDeps> = {}
  ) => {
    const f = hub([{ content: catalog(plugins), path: '.claude-plugin/marketplace.json' }]);
    const r = await readMarketplace(
      { ...loc, host: market },
      {},
      { ...deps(f), approvedHosts: async () => approved, ...over }
    );
    return r.marketplace.entries;
  };

  it('defaults a GitHub entry to the marketplace repository host', async () => {
    const [e] = await read(GHE, [gh()], [GHE]);
    expect(e).toMatchObject({ installable: true, source: { host: GHE, kind: 'github' } });
    const [g] = await read('github.com', [gh()], []);
    expect(g).toMatchObject({ installable: true, source: { host: 'github.com' } });
  });

  it('accepts an entry that names another approved host', async () => {
    const [e] = await read('github.com', [gh({ host: 'GHE.example.com' })], [GHE]);
    expect(e).toMatchObject({ installable: true, source: { host: GHE } });
    const [f] = await read(GHE, [gh({ host: 'github.com' })], [GHE]);
    expect(f).toMatchObject({ installable: true, source: { host: 'github.com' } });
  });

  it('lists an entry on an unapproved host, not installable, with the fixed reason', async () => {
    const [e] = await read('github.com', [gh({ host: 'evil.example.com' })], [GHE]);
    expect(e).toMatchObject({ installable: false, reason: ENTRY_REASONS.HOST_NOT_APPROVED });
    expect(e?.source).toMatchObject({ host: 'evil.example.com', kind: 'github' });
    expect(() => entryFolder(loc, e as never, SHA)).toThrow(MarketplaceInvalid);
  });

  it('refuses an Enterprise entry host in a github.com marketplace unless approved', async () => {
    const [refused] = await read('github.com', [gh({ host: GHE })], []);
    expect(refused?.installable).toBe(false);
    const [allowed] = await read('github.com', [gh({ host: GHE })], [GHE]);
    expect(allowed?.installable).toBe(true);
  });

  it('refuses an approved host that is a private address unless opted in', async () => {
    const [refused] = await read('github.com', [gh({ host: '10.0.0.5' })], ['10.0.0.5']);
    expect(refused?.installable).toBe(false);
    const [allowed] = await read('github.com', [gh({ host: '10.0.0.5' })], ['10.0.0.5'], {
      privateNetworkHosts: async () => ['10.0.0.5'],
    });
    expect(allowed?.installable).toBe(true);
  });

  it('refuses a host that is not a host name', async () => {
    const [e] = await read('github.com', [gh({ host: 'a/b' })], []);
    expect(e).toMatchObject({ installable: false, reason: ENTRY_REASONS.INVALID_REPO });
  });
});
