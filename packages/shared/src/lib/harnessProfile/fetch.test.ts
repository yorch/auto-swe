import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SkillSourceDeps } from '../skillSource/index.js';
import { readProfileFolder } from './fetch.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const blobId = (b: Buffer) =>
  createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

interface FakeEntry {
  path: string;
  content?: Buffer | string;
  mode?: string;
  type?: string;
  /** Reported size, when it should lie. */
  size?: number;
  /** Blob id, when it should lie. */
  id?: string;
}

function hub(
  entries: FakeEntry[],
  opts: { sha?: string; truncated?: boolean; blobBody?: (id: string) => Buffer | undefined } = {}
) {
  const blobs = new Map<string, Buffer>();
  const tree = entries.map((e) => {
    const content = Buffer.from(e.content ?? '');
    const id = e.id ?? blobId(content);
    blobs.set(id, content);
    return {
      mode: e.mode ?? '100644',
      path: e.path,
      sha: id,
      size: e.size ?? content.length,
      type: e.type ?? 'blob',
    };
  });
  const urls: string[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.includes('/commits/')) {
      return ok({ sha: opts.sha ?? SHA });
    }
    if (u.includes('/git/trees/')) {
      return ok({ tree, truncated: opts.truncated ?? false });
    }
    const m = /\/git\/blobs\/([0-9a-f]+)/.exec(u);
    const body = m ? blobs.get(m[1] as string) : undefined;
    return body
      ? ok({ content: body.toString('base64'), encoding: 'base64' })
      : new Response('{}', { status: 404 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, urls };
}

function deps(h: { fetchFn: typeof fetch }, over: Partial<SkillSourceDeps> = {}): SkillSourceDeps {
  return {
    approvedHosts: async () => [],
    fetch: h.fetchFn,
    githubConfig: (async () => ({
      apiUrl: 'https://api.github.com',
      baseUrl: 'https://github.com',
    })) as unknown as SkillSourceDeps['githubConfig'],
    githubToken: (async () => 'tok') as SkillSourceDeps['githubToken'],
    platformCredential: (async () => ({
      scope: 'none',
    })) as unknown as SkillSourceDeps['platformCredential'],
    privateNetworkHosts: async () => [],
    ...over,
  };
}

const loc = { host: 'github.com', owner: 'acme', path: 'profiles/demo', ref: 'main', repo: 'p' };

describe('readProfileFolder', () => {
  it('resolves the ref, lists the tree and downloads every file in the folder, binary included', async () => {
    const h = hub([
      { content: '{"name":"demo"}', path: 'profiles/demo/profile.json' },
      {
        content: Buffer.from([0, 1, 2, 255]),
        mode: '100755',
        path: 'profiles/demo/plugins/a/bin/tool',
      },
      { content: 'x', path: 'profiles/demo/plugins/a/img.png' },
      { content: 'outside', path: 'profiles/other/profile.json' },
      { mode: '040000', path: 'profiles/demo/plugins', type: 'tree' },
    ]);
    const r = await readProfileFolder(loc, {}, deps(h));
    expect(r.problems).toEqual([]);
    expect(r.sha).toBe(SHA);
    expect(r.files.map((f) => [f.path, f.mode])).toEqual([
      ['plugins/a/bin/tool', '100755'],
      ['plugins/a/img.png', '100644'],
      ['profile.json', '100644'],
    ]);
    expect(r.files[0]?.bytes.equals(Buffer.from([0, 1, 2, 255]))).toBe(true);
    // ref + tree + 3 blobs; the file outside the folder is never fetched
    expect(h.fetchFn).toHaveBeenCalledTimes(5);
  });

  it('reads the repository root when the path is empty', async () => {
    const h = hub([{ content: '{}', path: 'profile.json' }]);
    const r = await readProfileFolder({ ...loc, path: '' }, {}, deps(h));
    expect(r.files.map((f) => f.path)).toEqual(['profile.json']);
  });

  it('reports a symlink, a submodule and an odd mode as problems and downloads nothing', async () => {
    const h = hub([
      { content: '{}', path: 'profiles/demo/profile.json' },
      { content: 'target', mode: '120000', path: 'profiles/demo/link' },
      { mode: '160000', path: 'profiles/demo/sub', type: 'commit' },
      { content: 'x', mode: '100664', path: 'profiles/demo/odd' },
    ]);
    const r = await readProfileFolder(loc, {}, deps(h));
    expect(r.files).toEqual([]);
    expect(r.problems).toEqual([
      'symlink not allowed: link',
      'submodule not allowed: sub',
      'unsupported file type: odd',
    ]);
    expect(h.urls.some((u) => u.includes('/git/blobs/'))).toBe(false);
  });

  it('ignores a symlink outside the folder', async () => {
    const h = hub([
      { content: '{}', path: 'profiles/demo/profile.json' },
      { content: 't', mode: '120000', path: 'profiles/elsewhere/link' },
    ]);
    expect((await readProfileFolder(loc, {}, deps(h))).problems).toEqual([]);
  });

  it('reports unsafe names, duplicates and an empty folder', async () => {
    const hostile = hub([
      { content: 'x', path: 'profiles/demo/a\u001b[31mb' },
      { content: 'x', path: 'profiles/demo/.git/config' },
      { content: 'x', path: 'profiles/demo/Docs.md' },
      { content: 'y', path: 'profiles/demo/docs.md' },
    ]);
    const r = await readProfileFolder(loc, {}, deps(hostile));
    expect(r.problems.join('\n')).toContain('control or invisible characters in path');
    expect(r.problems.join('\n')).toContain("'.git' segment");
    expect(r.problems.join('\n')).toContain('duplicate path after normalisation');
    expect(r.problems.join('\n')).not.toContain('\u001b');

    const empty = await readProfileFolder(loc, {}, deps(hub([{ content: 'x', path: 'other/x' }])));
    expect(empty.problems).toEqual(['the folder is empty or does not exist at that commit']);
  });

  it('refuses a folder over the file, per-file or total byte limits before downloading', async () => {
    const many = hub(
      Array.from({ length: 501 }, (_, i) => ({ content: '', path: `profiles/demo/f${i}` }))
    );
    expect((await readProfileFolder(loc, {}, deps(many))).problems).toContain(
      'the folder holds more than 500 files'
    );
    const big = hub([{ content: 'x', path: 'profiles/demo/big', size: 1_000_001 }]);
    expect((await readProfileFolder(loc, {}, deps(big))).problems[0]).toMatch(
      /exceeds 1000000 bytes/
    );
    const total = hub(
      Array.from({ length: 6 }, (_, i) => ({
        content: 'x',
        path: `profiles/demo/c${i}`,
        size: 900_000,
      }))
    );
    expect((await readProfileFolder(loc, {}, deps(total))).problems).toContain(
      'the folder exceeds 5000000 bytes in total'
    );
    expect(total.urls.some((u) => u.includes('/git/blobs/'))).toBe(false);
  });

  it('fails LIMIT_REQUESTS when the request budget is smaller than the folder', async () => {
    const h = hub(
      Array.from({ length: 5 }, (_, i) => ({ content: `${i}`, path: `profiles/demo/f${i}` }))
    );
    await expect(
      readProfileFolder(loc, {}, deps(h, { limits: { maxRequests: 4 } }))
    ).rejects.toMatchObject({
      code: 'LIMIT_REQUESTS',
    });
    expect(h.urls.some((u) => u.includes('/git/blobs/'))).toBe(false);
  });

  it('fails SHA_MOVED when the ref no longer resolves to the previewed commit', async () => {
    const h = hub([{ content: '{}', path: 'profiles/demo/profile.json' }], { sha: OTHER });
    await expect(readProfileFolder(loc, { expectSha: SHA }, deps(h))).rejects.toMatchObject({
      code: 'SHA_MOVED',
    });
    expect(h.urls.some((u) => u.includes('/git/'))).toBe(false);
  });

  it('reads an exact commit without resolving the ref', async () => {
    const h = hub([{ content: '{}', path: 'profiles/demo/profile.json' }]);
    const r = await readProfileFolder(loc, { atSha: OTHER }, deps(h));
    expect(r.sha).toBe(OTHER);
    expect(h.urls.some((u) => u.includes('/commits/'))).toBe(false);
    await expect(readProfileFolder(loc, { atSha: 'main' }, deps(h))).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
    });
  });

  it('refuses a truncated tree', async () => {
    const h = hub([{ content: '{}', path: 'profiles/demo/profile.json' }], { truncated: true });
    await expect(readProfileFolder(loc, {}, deps(h))).rejects.toMatchObject({
      code: 'TREE_TRUNCATED',
    });
  });

  it('refuses content that does not match the listed object id or size', async () => {
    const lie = hub([{ content: 'real', id: 'c'.repeat(40), path: 'profiles/demo/profile.json' }]);
    await expect(readProfileFolder(loc, {}, deps(lie))).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
    const wrongSize = hub([{ content: 'real', path: 'profiles/demo/profile.json', size: 2 }]);
    await expect(readProfileFolder(loc, {}, deps(wrongSize))).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });

  it('applies the skill-source host policy', async () => {
    const h = hub([]);
    await expect(
      readProfileFolder({ ...loc, host: 'evil.example.com' }, {}, deps(h))
    ).rejects.toMatchObject({ code: 'HOST_NOT_APPROVED' });
    await expect(readProfileFolder({ ...loc, ref: '../x' }, {}, deps(h))).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
    });
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it('downloads only the requested file with onlyPath, still verifying the whole listing', async () => {
    const h = hub([
      { content: '{}', path: 'profiles/demo/profile.json' },
      { content: 'one', path: 'profiles/demo/a.md' },
      { content: 'two', path: 'profiles/demo/b.md' },
    ]);
    const r = await readProfileFolder(loc, { atSha: SHA, onlyPath: 'b.md' }, deps(h));
    expect(r.files.map((x) => x.path)).toEqual(['b.md']);
    expect(h.urls.filter((u) => u.includes('/git/blobs/'))).toHaveLength(1);
    const none = await readProfileFolder(loc, { atSha: SHA, onlyPath: 'nope' }, deps(h));
    expect(none.files).toEqual([]);

    const bad = hub([
      { content: '{}', path: 'profiles/demo/profile.json' },
      { content: 'target', mode: '120000', path: 'profiles/demo/link' },
    ]);
    const refused = await readProfileFolder(
      loc,
      { atSha: SHA, onlyPath: 'profile.json' },
      deps(bad)
    );
    expect(refused.problems).toEqual(['symlink not allowed: link']);
    expect(bad.urls.some((u) => u.includes('/git/blobs/'))).toBe(false);
  });

  it('refuses a listing whose size is negative or not an integer', async () => {
    for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      const h = hub([{ content: 'x', path: 'profiles/demo/profile.json', size }]);
      await expect(readProfileFolder(loc, {}, deps(h))).rejects.toMatchObject({
        code: 'BAD_RESPONSE',
      });
      expect(h.urls.some((u) => u.includes('/git/blobs/'))).toBe(false);
    }
  });

  it('starts no further downloads after one fails', async () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      content: `file ${i}`,
      id: i === 0 ? 'c'.repeat(40) : undefined,
      path: `profiles/demo/f${String(i).padStart(2, '0')}`,
    }));
    const h = hub(entries);
    await expect(readProfileFolder(loc, {}, deps(h))).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
    expect(h.urls.filter((u) => u.includes('/git/blobs/')).length).toBeLessThan(40);
  });
});
