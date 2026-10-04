import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchSkillSource,
  MAX_API_REQUESTS,
  MAX_REFERENCE_FILES,
  MAX_SKILLS_PER_SOURCE,
  normaliseLocation,
  parseSkillMd,
  resolveSourceSha,
  type SkillSourceDeps,
  SkillSourceError,
} from './index.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TOKEN = 'ghp_FAKE-TOKEN-1234';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

interface FakeFile {
  path: string;
  content?: string;
  mode?: string;
  type?: string;
  size?: number;
}

const skillMd = (name: string, body = 'Do the thing.', description = 'Does a thing') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

interface Reply {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

/** A fake GitHub: routes by URL substring; records every call. */
function fakeHub(opts: {
  files: FakeFile[];
  sha?: string;
  truncated?: boolean;
  routes?: Record<string, Reply>;
  /** Headers on every default (non-routed) response. */
  headers?: Record<string, string>;
}) {
  const blobs = new Map<string, string>();
  const tree = opts.files.map((f) => {
    const content = f.content ?? '';
    const sha = sha1(`${f.path}\0${content}`);
    blobs.set(sha, content);
    return {
      mode: f.mode ?? '100644',
      path: f.path,
      sha,
      size: f.size ?? Buffer.byteLength(content),
      type: f.type ?? 'blob',
    };
  });
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ headers: { ...(init?.headers as Record<string, string>) }, url: u });
    for (const [needle, reply] of Object.entries(opts.routes ?? {})) {
      if (u.includes(needle)) {
        return new Response(JSON.stringify(reply.json ?? {}), {
          headers: reply.headers,
          status: reply.status ?? 200,
        });
      }
    }
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: opts.headers, status: 200 });
    if (u.includes('/commits/')) {
      return json({ sha: opts.sha ?? SHA });
    }
    if (u.includes('/git/trees/')) {
      return json({ sha: opts.sha ?? SHA, tree, truncated: opts.truncated ?? false });
    }
    const blob = /\/git\/blobs\/([0-9a-f]+)/.exec(u);
    if (blob) {
      const text = blobs.get(blob[1] as string);
      if (text === undefined) {
        return new Response('{}', { status: 404 });
      }
      return json({
        content: Buffer.from(text).toString('base64'),
        encoding: 'base64',
        size: Buffer.byteLength(text),
      });
    }
    return new Response('{}', { status: 404 });
  });
  return { calls, fetchFn };
}

function deps(
  hub: { fetchFn: typeof fetch },
  over: Partial<SkillSourceDeps> & { baseUrl?: string; apiUrl?: string; token?: string | null } = {}
): SkillSourceDeps {
  return {
    approvedHosts: async () => ['ghe.example.com'],
    fetch: hub.fetchFn,
    githubConfig: (async () => ({
      apiUrl: over.apiUrl ?? 'https://ghe.example.com/api/v3',
      baseUrl: over.baseUrl ?? 'https://ghe.example.com',
    })) as unknown as SkillSourceDeps['githubConfig'],
    githubToken: (async () => over.token ?? TOKEN) as SkillSourceDeps['githubToken'],
    platformCredential: (async (repo: { baseUrl?: string | null }) =>
      repo.baseUrl === 'https://ghe.example.com'
        ? { config: {}, scope: 'instance' }
        : { host: 'x', scope: 'mismatch' }) as unknown as SkillSourceDeps['platformCredential'],
    privateNetworkHosts: async () => [],
    ...over,
  };
}

const loc = (over: Partial<Parameters<typeof normaliseLocation>[0]> = {}) => ({
  host: 'github.com',
  owner: 'Acme',
  path: '',
  ref: 'main',
  repo: 'Skills',
  ...over,
});

describe('normaliseLocation', () => {
  it('lowercases host/owner/repo and strips a trailing slash from the path', () => {
    expect(normaliseLocation(loc({ host: 'GitHub.com', path: 'a/b/' }))).toEqual({
      host: 'github.com',
      owner: 'acme',
      path: 'a/b',
      ref: 'main',
      repo: 'skills',
    });
  });

  it.each([
    ['dotdot path', { path: '../x' }],
    ['inner dotdot', { path: 'a/../b' }],
    ['absolute path', { path: '/etc' }],
    ['backslash path', { path: 'a\\b' }],
    ['empty segment', { path: 'a//b' }],
    ['bad owner', { owner: 'a/b' }],
    ['bad repo', { repo: '..' }],
    ['ref with dotdot', { ref: 'a..b' }],
    ['ref with space', { ref: 'a b' }],
    ['ref starting with dash', { ref: '-x' }],
    ['empty ref', { ref: '' }],
  ])('refuses %s', (_label, over) => {
    expect(() => normaliseLocation(loc(over))).toThrow(SkillSourceError);
  });
});

describe('parseSkillMd', () => {
  it('reads name, description and the body', () => {
    expect(parseSkillMd(skillMd('code-review', 'Body text', 'Reviews code'))).toEqual({
      description: 'Reviews code',
      ignoredKeys: [],
      name: 'code-review',
      ok: true,
      promptText: 'Body text',
    });
  });

  it('handles CRLF, a BOM and a folded multi-line description', () => {
    const text = '﻿---\r\nname: x\r\ndescription: >\r\n  one\r\n  two\r\n---\r\nBody\r\n';
    expect(parseSkillMd(text)).toMatchObject({ description: 'one two', ok: true });
  });

  it('flattens a description to one line', () => {
    const r = parseSkillMd('---\nname: x\ndescription: "a\\n- **evil**: b"\n---\nbody');
    expect(r).toMatchObject({ description: 'a - **evil**: b', ok: true });
  });

  it.each([
    ['no frontmatter', 'just text'],
    ['unterminated frontmatter', '---\nname: x\n'],
    ['invalid yaml', '---\nname: [unclosed\n---\nbody'],
    ['not a mapping', '---\n- a\n- b\n---\nbody'],
    ['missing name', '---\ndescription: d\n---\nbody'],
    ['numeric name', '---\nname: 12\ndescription: d\n---\nbody'.replace('12', '{a: 1}')],
    ['name with newline-ish chars', '---\nname: "a\\nb"\ndescription: d\n---\nbody'],
    ['name with markdown', '---\nname: "**x**"\ndescription: d\n---\nbody'],
    ['missing description', '---\nname: x\n---\nbody'],
    ['empty body', '---\nname: x\ndescription: d\n---\n\n'],
    ['alias bomb', '---\nname: x\ndescription: &a d\nother: *a\n---\nbody'],
  ])('returns a per-skill error for %s', (_label, text) => {
    const r = parseSkillMd(text);
    expect(r.ok).toBe(false);
  });

  it('refuses an over-long description and body without truncating', () => {
    expect(parseSkillMd(skillMd('x', 'b', 'd'.repeat(1001))).ok).toBe(false);
    expect(parseSkillMd(skillMd('x', 'b'.repeat(50_001))).ok).toBe(false);
  });

  it('never echoes the parser message', () => {
    const r = parseSkillMd('---\nname: [secret-ish\n---\nbody');
    expect(r).toEqual({ error: 'frontmatter is not valid YAML', ok: false });
  });
});

describe('host policy', () => {
  it('refuses an unapproved host before any request', async () => {
    const hub = fakeHub({ files: [] });
    await expect(
      fetchSkillSource(loc({ host: 'evil.example.com' }), { scriptMode: 'TEXT_ONLY' }, deps(hub))
    ).rejects.toMatchObject({ code: 'HOST_NOT_APPROVED' });
    expect(hub.fetchFn).not.toHaveBeenCalled();
  });

  it('refuses an approved host that is a private address, before any request', async () => {
    const hub = fakeHub({ files: [] });
    const d = deps(hub, { approvedHosts: async () => ['10.0.0.5'] });
    await expect(
      fetchSkillSource(loc({ host: '10.0.0.5' }), { scriptMode: 'TEXT_ONLY' }, d)
    ).rejects.toMatchObject({ code: 'HOST_BLOCKED' });
    expect(hub.fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a malformed host', async () => {
    const hub = fakeHub({ files: [] });
    await expect(
      fetchSkillSource(loc({ host: 'a b' }), { scriptMode: 'TEXT_ONLY' }, deps(hub))
    ).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(hub.fetchFn).not.toHaveBeenCalled();
  });

  it('reads github.com anonymously: no Authorization header', async () => {
    const hub = fakeHub({ files: [{ content: skillMd('a'), path: 'a/SKILL.md' }] });
    await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub));
    expect(hub.calls.length).toBeGreaterThan(0);
    for (const c of hub.calls) {
      expect(c.url.startsWith('https://api.github.com/repos/acme/skills/')).toBe(true);
      expect(c.headers.Authorization).toBeUndefined();
    }
  });

  it('sends the instance token to the instance host only', async () => {
    const hub = fakeHub({ files: [{ content: skillMd('a'), path: 'a/SKILL.md' }] });
    await fetchSkillSource(
      loc({ host: 'ghe.example.com' }),
      { scriptMode: 'TEXT_ONLY' },
      deps(hub)
    );
    for (const c of hub.calls) {
      expect(c.url.startsWith('https://ghe.example.com/api/v3/repos/acme/skills/')).toBe(true);
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('falls back to anonymous when the token cannot be minted', async () => {
    const hub = fakeHub({ files: [{ content: skillMd('a'), path: 'a/SKILL.md' }] });
    const d = deps(hub, {
      githubToken: (async () => {
        throw new Error('no installation');
      }) as SkillSourceDeps['githubToken'],
    });
    await fetchSkillSource(loc({ host: 'ghe.example.com' }), { scriptMode: 'TEXT_ONLY' }, d);
    for (const c of hub.calls) {
      expect(c.headers.Authorization).toBeUndefined();
    }
  });
});

describe('private-network hosts (per-host opt-in)', () => {
  const files = [{ content: skillMd('a'), path: 'a/SKILL.md' }];
  const run = (
    host: string,
    over: { approved?: string[]; optedIn?: string[]; routes?: Record<string, Reply> } = {}
  ) => {
    const hub = fakeHub({ files, routes: over.routes });
    const d = deps(hub, {
      apiUrl: 'https://api.github.com',
      approvedHosts: async () => over.approved ?? [host],
      baseUrl: 'https://github.com',
      privateNetworkHosts: async () => over.optedIn ?? [],
    });
    return { hub, p: fetchSkillSource(loc({ host }), { scriptMode: 'TEXT_ONLY' }, d) };
  };

  it('refuses an approved private host by default, before any request', async () => {
    const { hub, p } = run('10.0.0.5');
    await expect(p).rejects.toMatchObject({ code: 'HOST_BLOCKED' });
    expect(hub.fetchFn).not.toHaveBeenCalled();
  });

  it('reads a private host that is both approved and opted in', async () => {
    const { hub, p } = run('10.0.0.5', { optedIn: ['10.0.0.5'] });
    expect((await p).skills).toHaveLength(1);
    expect(hub.calls[0]?.url.startsWith('https://10.0.0.5/api/v3/')).toBe(true);
  });

  it('also covers a .internal/.local name and a host:port', async () => {
    for (const host of ['ghe.corp.internal', 'ghe.corp.local', '192.168.1.9:8443']) {
      const { p } = run(host, { optedIn: [host] });
      expect((await p).skills).toHaveLength(1);
    }
  });

  it('opt-in alone is not enough: the host must also be approved', async () => {
    const { hub, p } = run('10.0.0.5', { approved: [], optedIn: ['10.0.0.5'] });
    await expect(p).rejects.toMatchObject({ code: 'HOST_NOT_APPROVED' });
    expect(hub.fetchFn).not.toHaveBeenCalled();
  });

  it('the opt-in names exact hosts: another private host stays refused', async () => {
    const { hub, p } = run('10.0.0.6', {
      approved: ['10.0.0.5', '10.0.0.6'],
      optedIn: ['10.0.0.5'],
    });
    await expect(p).rejects.toMatchObject({ code: 'HOST_BLOCKED' });
    expect(hub.fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    '169.254.169.254',
    '127.0.0.1',
    'localhost',
    'metadata.google.internal',
    '100.100.100.200',
    '0.0.0.0',
  ])('never reaches %s, even approved and opted in', async (host) => {
    const { hub, p } = run(host, { optedIn: [host] });
    await expect(p).rejects.toMatchObject({ code: 'HOST_BLOCKED' });
    expect(hub.fetchFn).not.toHaveBeenCalled();
  });

  it('github.com is not made private-capable by being listed', async () => {
    const hub = fakeHub({ files });
    const d = deps(hub, {
      approvedHosts: async () => [],
      privateNetworkHosts: async () => ['github.com'],
    });
    await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, d);
    expect(hub.calls[0]?.url.startsWith('https://api.github.com/')).toBe(true);
  });

  it('re-checks redirect hops: metadata and an unlisted private host are refused', async () => {
    for (const target of ['https://169.254.169.254/latest', 'https://10.0.0.9/x']) {
      const { hub, p } = run('10.0.0.5', {
        optedIn: ['10.0.0.5'],
        routes: { '/commits/main': { headers: { location: target }, status: 302 } },
      });
      await expect(p).rejects.toMatchObject({ code: 'HOST_BLOCKED' });
      expect(hub.calls.every((c) => !c.url.includes(target.slice(8, 16)))).toBe(true);
    }
  });

  it('follows a redirect that stays on the opted-in host', async () => {
    const { p } = run('10.0.0.5', {
      optedIn: ['10.0.0.5'],
      routes: {
        '/repos/acme/skills/commits/main': {
          headers: { location: 'https://10.0.0.5/api/v3/repositories/1/commits/main' },
          status: 301,
        },
      },
    });
    expect((await p).skills).toHaveLength(1);
  });
});

describe('redirects', () => {
  const redirectTo = (to: string): Reply => ({ headers: { location: to }, status: 301 });

  it('follows a same-origin redirect, keeping the token', async () => {
    const hub = fakeHub({
      files: [{ content: skillMd('a'), path: 'a/SKILL.md' }],
      routes: {
        '/repos/acme/skills/commits/main': redirectTo(
          'https://ghe.example.com/api/v3/repositories/1/commits/main'
        ),
      },
    });
    // The redirected URL is not routed, so it falls through to the commit stub.
    await fetchSkillSource(
      loc({ host: 'ghe.example.com' }),
      { scriptMode: 'TEXT_ONLY' },
      deps(hub)
    );
    const hop = hub.calls.find((c) => c.url.includes('/repositories/1/'));
    expect(hop?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses a redirect to a private address and never sends the token there', async () => {
    const hub = fakeHub({
      files: [],
      routes: { '/commits/main': redirectTo('https://127.0.0.1/steal') },
    });
    await expect(
      fetchSkillSource(loc({ host: 'ghe.example.com' }), { scriptMode: 'TEXT_ONLY' }, deps(hub))
    ).rejects.toMatchObject({ code: 'HOST_BLOCKED' });
    expect(hub.calls.every((c) => !c.url.includes('127.0.0.1'))).toBe(true);
  });

  it('refuses a redirect to a host that is not approved', async () => {
    const hub = fakeHub({
      files: [],
      routes: { '/commits/main': redirectTo('https://elsewhere.example.org/x') },
    });
    await expect(
      fetchSkillSource(loc({ host: 'ghe.example.com' }), { scriptMode: 'TEXT_ONLY' }, deps(hub))
    ).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
    expect(hub.calls.every((c) => !c.url.includes('elsewhere'))).toBe(true);
  });

  it('sends no token on an allowed cross-origin hop', async () => {
    const hub = fakeHub({
      files: [{ content: skillMd('a'), path: 'a/SKILL.md' }],
      routes: { '/commits/main': redirectTo('https://github.com/api-elsewhere/commits/x') },
    });
    const d = deps(hub, { approvedHosts: async () => ['ghe.example.com', 'github.com'] });
    await fetchSkillSource(loc({ host: 'ghe.example.com' }), { scriptMode: 'TEXT_ONLY' }, d);
    const hop = hub.calls.find((c) => c.url.startsWith('https://github.com/'));
    expect(hop).toBeDefined();
    expect(hop?.headers.Authorization).toBeUndefined();
  });

  it('gives up after too many redirects', async () => {
    const hub = fakeHub({
      files: [],
      routes: { '/commits/main': redirectTo('https://ghe.example.com/api/v3/commits/main') },
    });
    await expect(
      fetchSkillSource(loc({ host: 'ghe.example.com' }), { scriptMode: 'TEXT_ONLY' }, deps(hub))
    ).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
  });
});

describe('listing', () => {
  const run = (
    files: FakeFile[],
    over: Parameters<typeof loc>[0] = {},
    mode = 'TEXT_ONLY' as const
  ) => {
    const hub = fakeHub({ files });
    return { hub, p: fetchSkillSource(loc(over), { scriptMode: mode }, deps(hub)) };
  };

  it('resolves the ref to a commit and lists that commit, fetching blobs by sha', async () => {
    const { hub, p } = run([{ content: skillMd('a'), path: 'a/SKILL.md' }]);
    const out = await p;
    expect(out.sha).toBe(SHA);
    expect(hub.calls[0]?.url).toContain('/commits/main');
    expect(hub.calls[1]?.url).toContain(`/git/trees/${SHA}?recursive=1`);
    expect(hub.calls[2]?.url).toMatch(/\/git\/blobs\/[0-9a-f]{40}$/);
    expect(hub.calls.some((c) => /tarball|zipball|codeload|\/contents\//.test(c.url))).toBe(false);
  });

  it('refuses a truncated tree', async () => {
    const hub = fakeHub({
      files: [{ content: skillMd('a'), path: 'a/SKILL.md' }],
      truncated: true,
    });
    await expect(
      fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))
    ).rejects.toMatchObject({ code: 'TREE_TRUNCATED' });
  });

  it('skips symlinks and submodules and lists them', async () => {
    const { p } = run([
      { content: skillMd('a'), path: 'a/SKILL.md' },
      { content: 'target', mode: '120000', path: 'a/link.md' },
      { mode: '160000', path: 'a/vendor', type: 'commit' },
    ]);
    const [skill] = (await p).skills;
    expect(skill?.errors).toEqual([]);
    expect(skill?.skippedFiles).toEqual(
      expect.arrayContaining([
        { path: 'link.md', reason: 'symlink' },
        { path: 'vendor', reason: 'submodule' },
      ])
    );
    expect(skill?.referenceFiles).toEqual([]);
  });

  it('does not treat a symlinked SKILL.md as a skill', async () => {
    const { p } = run([{ content: 'x', mode: '120000', path: 'a/SKILL.md' }]);
    await expect(p).rejects.toMatchObject({ code: 'NO_SKILLS' });
  });

  it('refuses a listing with a `..` or absolute path', async () => {
    for (const bad of ['a/../x/SKILL.md', '/abs/SKILL.md', 'a\\b/SKILL.md']) {
      const { p } = run([{ content: skillMd('a'), path: bad }]);
      await expect(p).rejects.toMatchObject({ code: 'BAD_PATH' });
    }
  });

  it('stays under the path: skills outside it are not read', async () => {
    const { hub, p } = run(
      [
        { content: skillMd('inside'), path: 'skills/in/SKILL.md' },
        { content: skillMd('outside'), path: 'other/out/SKILL.md' },
        { content: skillMd('prefix'), path: 'skills-extra/x/SKILL.md' },
      ],
      { path: 'skills' }
    );
    const out = await p;
    expect(out.skills.map((s) => s.name)).toEqual(['inside']);
    expect(out.skills[0]?.folder).toBe('skills/in');
    expect(hub.calls.filter((c) => c.url.includes('/git/blobs/'))).toHaveLength(1);
  });

  it('finds a SKILL.md at the repository root', async () => {
    const { p } = run([
      { content: skillMd('root'), path: 'SKILL.md' },
      { content: 'ref', path: 'notes.md' },
    ]);
    const [s] = (await p).skills;
    expect(s?.folder).toBe('');
    expect(s?.referenceFiles).toEqual([{ content: 'ref', path: 'notes.md' }]);
  });

  it('gives each skill its own files and not those of a nested skill', async () => {
    const { p } = run([
      { content: skillMd('outer'), path: 'o/SKILL.md' },
      { content: 'outer ref', path: 'o/ref.md' },
      { content: skillMd('inner'), path: 'o/inner/SKILL.md' },
      { content: 'inner ref', path: 'o/inner/ref.md' },
    ]);
    const skills = (await p).skills;
    expect(skills.find((s) => s.name === 'outer')?.referenceFiles.map((f) => f.path)).toEqual([
      'ref.md',
    ]);
    expect(skills.find((s) => s.name === 'inner')?.referenceFiles.map((f) => f.path)).toEqual([
      'ref.md',
    ]);
  });

  it('reports a bad skill on that skill without failing the others', async () => {
    const { p } = run([
      { content: skillMd('good'), path: 'good/SKILL.md' },
      { content: 'no frontmatter', path: 'bad/SKILL.md' },
    ]);
    const skills = (await p).skills;
    expect(skills.find((s) => s.folder === 'good')?.errors).toEqual([]);
    expect(skills.find((s) => s.folder === 'bad')?.errors).toEqual([
      'SKILL.md has no YAML frontmatter',
    ]);
  });

  it('flags two skills with the same name', async () => {
    const { p } = run([
      { content: skillMd('dup'), path: 'a/SKILL.md' },
      { content: skillMd('Dup'), path: 'b/SKILL.md' },
    ]);
    for (const s of (await p).skills) {
      expect(s.errors).toContain('another skill in this source has the same name');
    }
  });

  it('fails with NO_SKILLS when there is no SKILL.md', async () => {
    const { p } = run([{ content: 'x', path: 'README.md' }]);
    await expect(p).rejects.toMatchObject({ code: 'NO_SKILLS' });
  });

  it('refuses when the ref no longer resolves to the expected commit', async () => {
    const hub = fakeHub({ files: [{ content: skillMd('a'), path: 'a/SKILL.md' }], sha: OTHER });
    await expect(
      fetchSkillSource(loc(), { expectSha: SHA, scriptMode: 'TEXT_ONLY' }, deps(hub))
    ).rejects.toMatchObject({ code: 'SHA_MOVED' });
    // Nothing but the ref lookup was requested.
    expect(hub.calls).toHaveLength(1);
  });

  it('resolveSourceSha returns just the commit', async () => {
    const hub = fakeHub({ files: [] });
    expect(await resolveSourceSha(loc(), deps(hub))).toBe(SHA);
    expect(hub.calls).toHaveLength(1);
  });

  it('rejects a non-hex sha in a response', async () => {
    const hub = fakeHub({ files: [], sha: 'not-a-sha' });
    await expect(resolveSourceSha(loc(), deps(hub))).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });
});

describe('script modes', () => {
  const files: FakeFile[] = [
    { content: skillMd('s'), path: 's/SKILL.md' },
    { content: 'notes', path: 's/notes.md' },
    { content: 'more', path: 's/docs/more.txt' },
    { content: 'echo hi', path: 's/run.sh' },
    { content: 'print()', path: 's/scripts/x.py' },
    { content: '\u0000\u0001', path: 's/logo.png' },
  ];

  it('TEXT_ONLY stores .md/.txt as reference text and lists everything else as skipped', async () => {
    const hub = fakeHub({ files });
    const [s] = (await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))).skills;
    expect(s?.errors).toEqual([]);
    expect(s?.referenceFiles).toEqual(
      expect.arrayContaining([
        { content: 'notes', path: 'notes.md' },
        { content: 'more', path: 'docs/more.txt' },
      ])
    );
    expect(s?.skippedFiles.map((f) => f.path).sort()).toEqual([
      'logo.png',
      'run.sh',
      'scripts/x.py',
    ]);
    // Scripts are never even downloaded.
    const blobCalls = hub.calls.filter((c) => c.url.includes('/git/blobs/'));
    expect(blobCalls).toHaveLength(3);
  });

  it('REJECT refuses a skill folder holding any other file, naming the files', async () => {
    const hub = fakeHub({ files });
    const [s] = (await fetchSkillSource(loc(), { scriptMode: 'REJECT' }, deps(hub))).skills;
    expect(s?.errors).toHaveLength(1);
    expect(s?.errors[0]).toMatch(/run\.sh/);
    expect(s?.errors[0]).toMatch(/scripts\/x\.py/);
    expect(s?.referenceFiles).toEqual([]);
    expect(hub.calls.filter((c) => c.url.includes('/git/blobs/'))).toHaveLength(0);
  });

  it('REJECT leaves a text-only folder alone', async () => {
    const hub = fakeHub({
      files: [
        { content: skillMd('s'), path: 's/SKILL.md' },
        { content: 'notes', path: 's/notes.md' },
      ],
    });
    const [s] = (await fetchSkillSource(loc(), { scriptMode: 'REJECT' }, deps(hub))).skills;
    expect(s?.errors).toEqual([]);
    expect(s?.referenceFiles).toHaveLength(1);
  });

  it('control characters in a file name cannot reshape the error', async () => {
    const hub = fakeHub({
      files: [
        { content: skillMd('s'), path: 's/SKILL.md' },
        { content: 'x', path: 's/evil\nname.sh' },
      ],
    });
    const [s] = (await fetchSkillSource(loc(), { scriptMode: 'REJECT' }, deps(hub))).skills;
    expect(s?.errors[0]).not.toMatch(/\n/);
  });
});

describe('limits', () => {
  it('refuses more than the maximum number of skills', async () => {
    const files = Array.from({ length: MAX_SKILLS_PER_SOURCE + 1 }, (_, i) => ({
      content: skillMd(`s${i}`),
      path: `s${i}/SKILL.md`,
    }));
    const hub = fakeHub({ files });
    await expect(
      fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))
    ).rejects.toMatchObject({ code: 'LIMIT_SKILLS' });
    expect(hub.calls.filter((c) => c.url.includes('/git/blobs/'))).toHaveLength(0);
  });

  it('accepts exactly the maximum number of skills', async () => {
    const files = Array.from({ length: MAX_SKILLS_PER_SOURCE }, (_, i) => ({
      content: skillMd(`s${i}`),
      path: `s${i}/SKILL.md`,
    }));
    const hub = fakeHub({ files });
    const out = await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub));
    expect(out.skills).toHaveLength(MAX_SKILLS_PER_SOURCE);
  });

  it('refuses a source over the total size before fetching any blob', async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({
      content: skillMd(`s${i}`),
      path: `s${i}/SKILL.md`,
      size: 190_000,
    }));
    const hub = fakeHub({ files });
    await expect(
      fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))
    ).rejects.toMatchObject({ code: 'LIMIT_BYTES' });
    expect(hub.calls.filter((c) => c.url.includes('/git/blobs/'))).toHaveLength(0);
  });

  it('flags a SKILL.md over the prompt text limit on that skill only', async () => {
    const hub = fakeHub({
      files: [
        { content: skillMd('big', 'x'.repeat(50_001)), path: 'big/SKILL.md' },
        { content: skillMd('ok'), path: 'ok/SKILL.md' },
      ],
    });
    const skills = (await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))).skills;
    expect(skills.find((s) => s.folder === 'big')?.errors).toHaveLength(1);
    expect(skills.find((s) => s.folder === 'ok')?.errors).toEqual([]);
  });

  it('skips reference files that are too large or too many, and lists them', async () => {
    const files: FakeFile[] = [
      { content: skillMd('s'), path: 's/SKILL.md' },
      { content: 'x', path: 's/huge.md', size: 5_000_000 },
      ...Array.from({ length: MAX_REFERENCE_FILES + 2 }, (_, i) => ({
        content: `r${i}`,
        path: `s/r${String(i).padStart(3, '0')}.md`,
      })),
    ];
    const hub = fakeHub({ files });
    // The oversized file is skipped rather than counted toward the total.
    const [s] = (await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))).skills;
    expect(s?.referenceFiles).toHaveLength(MAX_REFERENCE_FILES);
    expect(s?.skippedFiles.filter((f) => f.reason === 'too-large')).toHaveLength(1);
    expect(s?.skippedFiles.filter((f) => f.reason === 'too-many')).toHaveLength(2);
  });

  it('lists a non-UTF-8 reference file as unreadable', async () => {
    const hub = fakeHub({
      files: [
        { content: skillMd('s'), path: 's/SKILL.md' },
        { content: '�'.repeat(2), path: 's/odd.md' },
      ],
    });
    // Replace the served bytes with invalid UTF-8.
    const orig = hub.fetchFn.getMockImplementation();
    hub.fetchFn.mockImplementation(async (url, init) => {
      const res = await orig?.(url, init);
      const u = String(url);
      if (/blobs\//.test(u) && res) {
        const body = (await res.clone().json()) as { content: string };
        if (Buffer.from(body.content, 'base64').toString('utf8').includes('�')) {
          return new Response(
            JSON.stringify({
              content: Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'),
              encoding: 'base64',
            })
          );
        }
      }
      return res as Response;
    });
    const [s] = (await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))).skills;
    expect(s?.skippedFiles).toEqual([{ path: 'odd.md', reason: 'unreadable' }]);
  });
});

describe('error strings', () => {
  const USERINFO = 'bob:hunter2';

  const messageOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return err as Error;
    }
    throw new Error('expected a rejection');
  };

  it('never carries a header value or URL userinfo from a failed fetch', async () => {
    const hub = fakeHub({ files: [] });
    hub.fetchFn.mockImplementation(async () => {
      throw Object.assign(
        new TypeError(
          `Headers.append: "Bearer ${TOKEN}\r\nX-Evil: 1" is an invalid header value. ${USERINFO}@ghe.example.com`
        ),
        { cause: { code: 'ECONNRESET' } }
      );
    });
    const err = await messageOf(
      fetchSkillSource(loc({ host: 'ghe.example.com' }), { scriptMode: 'TEXT_ONLY' }, deps(hub))
    );
    expect(err).toBeInstanceOf(SkillSourceError);
    expect(err.message).toBe('request failed (TypeError, ECONNRESET)');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(USERINFO);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });

  it('a real fetch refusing a CRLF token does not leak it', async () => {
    const hub = fakeHub({ files: [] });
    const d = deps(hub, { token: `${TOKEN}\r\nX-Evil: 1` });
    d.fetch = (...args) => fetch(...args);
    const err = await messageOf(
      fetchSkillSource(loc({ host: 'ghe.example.com' }), { scriptMode: 'TEXT_ONLY' }, d)
    );
    expect(err).toBeInstanceOf(SkillSourceError);
    expect(err.message).not.toContain('FAKE-TOKEN');
    expect(err.message).not.toContain('X-Evil');
  });

  it('a timeout is a fixed string', async () => {
    const hub = fakeHub({ files: [] });
    hub.fetchFn.mockImplementation(async () => {
      throw Object.assign(new Error('aborted bob:hunter2@x'), { name: 'TimeoutError' });
    });
    const err = await messageOf(fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub)));
    expect(err.message).toBe('timed out');
  });

  it('maps statuses to fixed strings and never echoes the response body', async () => {
    const body = { message: `secret ${TOKEN} ${USERINFO}@evil` };
    const cases: Array<[Reply, string]> = [
      [{ json: body, status: 404 }, 'NOT_FOUND'],
      [{ json: body, status: 401 }, 'UNAUTHORIZED'],
      [{ json: body, status: 403 }, 'UNAUTHORIZED'],
      [{ headers: { 'x-ratelimit-remaining': '0' }, json: body, status: 403 }, 'RATE_LIMITED'],
      [{ json: body, status: 429 }, 'RATE_LIMITED'],
      [{ json: body, status: 500 }, 'HTTP_ERROR'],
    ];
    for (const [reply, code] of cases) {
      const hub = fakeHub({ files: [], routes: { '/commits/': reply } });
      const err = (await messageOf(
        fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))
      )) as SkillSourceError;
      expect(err.code).toBe(code);
      expect(err.message).not.toContain(TOKEN);
      expect(err.message).not.toContain(USERINFO);
    }
  });

  it('a non-JSON response is an unrecognised response', async () => {
    const hub = fakeHub({ files: [] });
    hub.fetchFn.mockImplementation(async () => new Response('<html>secret</html>'));
    const err = await messageOf(fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub)));
    expect(err.message).toBe('unrecognised response from the host');
  });
});

describe('request budget, deadline and rate-limit floor', () => {
  const one: FakeFile[] = [{ content: skillMd('a'), path: 'a/SKILL.md' }];
  const blobCount = (hub: { calls: Array<{ url: string }> }) =>
    hub.calls.filter((c) => c.url.includes('/git/blobs/')).length;

  it('drops reference files past the request budget and lists them, never exceeding it', async () => {
    // 100 skills x 5 reference files = 600 files; the budget is 300 requests.
    const files: FakeFile[] = Array.from({ length: 100 }, (_, i) => [
      { content: skillMd(`s${i}`), path: `s${i}/SKILL.md` },
      ...Array.from({ length: 5 }, (_, j) => ({ content: `r${j}`, path: `s${i}/r${j}.md` })),
    ]).flat();
    const hub = fakeHub({ files });
    const out = await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub));
    expect(hub.calls.length).toBeLessThanOrEqual(MAX_API_REQUESTS);
    expect(hub.calls.length).toBe(MAX_API_REQUESTS);
    // Every SKILL.md was read; the reference files that did not fit are listed.
    expect(out.skills.every((s) => s.errors.length === 0 && s.name !== null)).toBe(true);
    const kept = out.skills.reduce((n, s) => n + s.referenceFiles.length, 0);
    const dropped = out.skills.reduce(
      (n, s) => n + s.skippedFiles.filter((f) => f.reason === 'too-many').length,
      0
    );
    expect(kept).toBe(MAX_API_REQUESTS - 2 - 100);
    expect(kept + dropped).toBe(500);
  });

  it('refuses a source whose skills alone do not fit, before reading any blob', async () => {
    const files = Array.from({ length: 4 }, (_, i) => ({
      content: skillMd(`s${i}`),
      path: `s${i}/SKILL.md`,
    }));
    const hub = fakeHub({ files });
    const d = deps(hub, { limits: { maxRequests: 5 } });
    await expect(fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, d)).rejects.toMatchObject({
      code: 'LIMIT_REQUESTS',
    });
    expect(blobCount(hub)).toBe(0);
  });

  it('counts redirect hops against the budget', async () => {
    const hub = fakeHub({
      files: one,
      routes: {
        '/repos/acme/skills/commits/main': {
          headers: { location: 'https://ghe.example.com/api/v3/repositories/1/commits/main' },
          status: 301,
        },
      },
    });
    const d = deps(hub, { limits: { maxRequests: 3 } });
    // commit (1) + redirected commit (2) + tree (3) fit; the blob (4) does not.
    await expect(
      fetchSkillSource(loc({ host: 'ghe.example.com' }), { scriptMode: 'TEXT_ONLY' }, d)
    ).rejects.toMatchObject({ code: 'LIMIT_REQUESTS' });
    expect(hub.calls).toHaveLength(3);
  });

  it('stops at the overall deadline, not only per request', async () => {
    const hub = fakeHub({ files: one });
    const t = 0;
    const d = deps(hub, {
      // The clock jumps a minute after the first request.
      now: () => (hub.calls.length === 0 ? t : t + 61_000),
    });
    await expect(fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, d)).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    expect(hub.calls).toHaveLength(1);
  });

  it('hands each request the time left, so a slow body cannot outlive the deadline', async () => {
    const hub = fakeHub({ files: one });
    const signals: AbortSignal[] = [];
    const inner = hub.fetchFn.getMockImplementation();
    hub.fetchFn.mockImplementation(async (url, init) => {
      signals.push(init?.signal as AbortSignal);
      return inner?.(url, init) as Promise<Response>;
    });
    await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub));
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((sg) => sg instanceof AbortSignal && !sg.aborted)).toBe(true);
  });

  it('a timeout while the body is being read reports as timed out', async () => {
    const hub = fakeHub({ files: one });
    hub.fetchFn.mockImplementation(async () => {
      const body = new ReadableStream({
        pull() {
          throw Object.assign(new Error('aborted bob:hunter2@x'), { name: 'TimeoutError' });
        },
      });
      return new Response(body, { status: 200 });
    });
    await expect(
      fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))
    ).rejects.toMatchObject({ code: 'TIMEOUT', message: 'timed out' });
  });

  it('stops when the remaining rate budget falls under the floor', async () => {
    const hub = fakeHub({
      files: one,
      headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '150' },
    });
    await expect(
      fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))
    ).rejects.toMatchObject({ code: 'RATE_LIMIT_LOW' });
    // It stopped on the first response.
    expect(hub.calls).toHaveLength(1);
  });

  it('carries on while the remaining budget is above the floor', async () => {
    const hub = fakeHub({
      files: one,
      headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4000' },
    });
    expect(
      (await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))).skills
    ).toHaveLength(1);
  });

  it('scales the floor down for a small limit, so an anonymous 60/hour read can work', async () => {
    const ok = fakeHub({
      files: one,
      headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '50' },
    });
    await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(ok));
    const low = fakeHub({
      files: one,
      headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '5' },
    });
    await expect(
      fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(low))
    ).rejects.toMatchObject({
      code: 'RATE_LIMIT_LOW',
    });
  });

  it('ignores a host that reports no rate limit (a GHE with limits off)', async () => {
    const hub = fakeHub({ files: one });
    expect(
      (await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))).skills
    ).toHaveLength(1);
  });

  it('keeps the rate-limited response its own error', async () => {
    const hub = fakeHub({
      files: one,
      routes: { '/commits/': { headers: { 'x-ratelimit-remaining': '0' }, status: 403 } },
    });
    await expect(
      fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});

describe('repository-derived text', () => {
  const ESC = '\u001b[1A\u001b[2K\rx.sh';

  it('shows a skipped file name without its control characters', async () => {
    const hub = fakeHub({
      files: [
        { content: skillMd('a'), path: 'a/SKILL.md' },
        { content: 'x', path: `a/${ESC}` },
        { content: 'x', path: 'a/two\u0085lines.md', size: 1 },
      ],
    });
    const [s] = (await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))).skills;
    for (const f of s?.skippedFiles ?? []) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting there are none
      expect(f.path).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    expect(s?.skippedFiles.map((f) => f.path)).toContain('?[1A?[2K?x.sh');
  });

  it('refuses a skill folder whose name has control characters', async () => {
    const hub = fakeHub({ files: [{ content: skillMd('a'), path: `bad${'\u001b'}dir/SKILL.md` }] });
    const [s] = (await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))).skills;
    expect(s?.errors).toContain('the skill folder name contains control characters');
  });

  it('lists the frontmatter keys it ignores, safely', async () => {
    const text = '---\nname: a\ndescription: d\nallowed-tools: Bash\n"x\\u001b[2K": 1\n---\nbody';
    const hub = fakeHub({ files: [{ content: text, path: 'a/SKILL.md' }] });
    const [s] = (await fetchSkillSource(loc(), { scriptMode: 'TEXT_ONLY' }, deps(hub))).skills;
    expect(s?.ignoredKeys).toEqual(['allowed-tools', 'x?[2K']);
  });

  it('flattens U+0085, U+2028 and other control characters in a description', () => {
    const r = parseSkillMd(
      '---\nname: x\ndescription: "a\\u0085- **tdd**: b\\u2028c\\u001bd"\n---\nbody'
    );
    expect(r).toMatchObject({ description: 'a - **tdd**: b c d', ok: true });
  });

  it('rejects a ref with a `.` segment', () => {
    for (const ref of ['.', 'a/./b', './a']) {
      expect(() => normaliseLocation(loc({ ref }))).toThrow(SkillSourceError);
    }
  });
});
