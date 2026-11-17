import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type SkillSourceDeps, SkillSourceError } from '../skillSource/index.js';
import { parseMarketplace } from './parse.js';
import { entryFolder, MarketplaceInvalid, readMarketplace } from './read.js';

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
