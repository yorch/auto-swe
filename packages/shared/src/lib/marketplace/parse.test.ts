import { describe, expect, it } from 'vitest';
import { ENTRY_REASONS, parseMarketplace, safeRelativeFolder } from './parse.js';

const parse = (v: unknown) =>
  parseMarketplace(Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
const ok = (v: unknown) => {
  const r = parse(v);
  if (!r.ok) {
    throw new Error(r.errors.join(','));
  }
  return r.marketplace;
};
const SHA = 'c'.repeat(40);
const sha = SHA;

describe('safeRelativeFolder', () => {
  it.each([
    ['./plugins/a', 'plugins/a'],
    ['plugins/a/', 'plugins/a'],
    ['./', ''],
    ['.', ''],
  ])('accepts %s', (raw, out) => {
    expect(safeRelativeFolder(raw)).toBe(out);
  });
  it.each(['../a', 'a/../b', '/abs', 'a\\b', 'a//b', 'a/./b', 'a\u0000b', 'a‮b', '.git/x', ''])(
    'refuses %j',
    (raw) => {
      expect(safeRelativeFolder(raw)).toBeNull();
    }
  );
});

describe('parseMarketplace', () => {
  it('reads name, owner and entries, and lists unknown keys as ignored', () => {
    const m = ok({
      extra: 1,
      metadata: { description: 'x' },
      name: 'acme',
      owner: { email: 'a@b.c', name: 'Acme' },
      plugins: [
        {
          author: 'me',
          category: 'x',
          description: 'Formats code',
          name: 'fmt',
          source: './plugins/fmt',
          version: '1.2.0',
        },
      ],
    });
    expect(m).toMatchObject({ ignoredKeys: ['extra'], name: 'acme', ownerName: 'Acme' });
    expect(m.entries[0]).toEqual({
      description: 'Formats code',
      ignoredKeys: ['author', 'category'],
      installable: true,
      name: 'fmt',
      pluginManifest: null,
      reason: null,
      source: { kind: 'relative', path: 'plugins/fmt' },
      strict: true,
      version: '1.2.0',
    });
  });

  it('accepts a GitHub source with ref, sha and path, and defaults the ref to HEAD', () => {
    const m = ok({
      name: 'm',
      plugins: [
        { name: 'a', source: { repo: 'Acme/Tool', source: 'github' } },
        {
          name: 'b',
          source: { path: 'sub/dir', ref: 'v1', repo: 'acme/other', sha, source: 'github' },
        },
      ],
    });
    expect(m.entries[0]?.source).toEqual({
      host: 'github.com',
      kind: 'github',
      owner: 'acme',
      path: '',
      ref: 'HEAD',
      repo: 'tool',
      sha: null,
    });
    expect(m.entries[1]?.source).toMatchObject({ path: 'sub/dir', ref: 'v1', sha: SHA });
    expect(m.entries.every((e) => e.installable)).toBe(true);
  });

  it('puts a GitHub source on its own host, else the default host, else github.com', () => {
    const bytes = Buffer.from(
      JSON.stringify({
        name: 'm',
        plugins: [
          { name: 'a', source: { repo: 'x/a', source: 'github' } },
          { name: 'b', source: { host: 'Other.Example.com', repo: 'x/b', source: 'github' } },
        ],
      })
    );
    const r = parseMarketplace(bytes, { defaultHost: 'ghe.example.com' });
    const hosts = (res: typeof r) =>
      res.ok
        ? res.marketplace.entries.map((e) => e.source && 'host' in e.source && e.source.host)
        : [];
    expect(hosts(r)).toEqual(['ghe.example.com', 'other.example.com']);
    expect(hosts(parseMarketplace(bytes))).toEqual(['github.com', 'other.example.com']);
  });

  it('builds the plugin manifest of a strict: false entry and leaves a strict entry alone', () => {
    const m = ok({
      name: 'm',
      plugins: [
        {
          author: { name: 'Me' },
          commands: ['./commands/x.md'],
          description: 'D',
          hooks: { PreToolUse: [] },
          keywords: ['a', 'b'],
          license: 'MIT',
          mcpServers: { s: { type: 'http', url: 'https://x.example.com' } },
          name: 'loose',
          skills: './skills',
          source: './p',
          strict: false,
          unknownThing: 1,
          version: '2.0.0',
        },
        { commands: ['./c'], name: 'tight', source: './q' },
        { author: 5, name: 'bad-author', source: './r', strict: false },
      ],
    });
    expect(m.entries[0]?.pluginManifest).toEqual({
      author: { name: 'Me' },
      commands: ['./commands/x.md'],
      description: 'D',
      hooks: { PreToolUse: [] },
      keywords: ['a', 'b'],
      license: 'MIT',
      mcpServers: { s: { type: 'http', url: 'https://x.example.com' } },
      name: 'loose',
      skills: './skills',
      version: '2.0.0',
    });
    expect(m.entries[0]).toMatchObject({ ignoredKeys: ['unknownThing'], strict: false });
    expect(m.entries[1]).toMatchObject({
      ignoredKeys: ['commands'],
      pluginManifest: null,
      strict: true,
    });
    expect(m.entries[2]?.pluginManifest).toEqual({ name: 'bad-author' });
  });

  it('lists a git URL, npm and another source type as not installable', () => {
    const m = ok({
      name: 'm',
      plugins: [
        { name: 'a', source: 'https://example.com/x.git' },
        { name: 'b', source: { source: 'url', url: 'https://example.com/x.git' } },
        { name: 'c', source: { package: 'p', source: 'npm' } },
        { name: 'd', source: 'git@github.com:a/b.git' },
      ],
    });
    for (const e of m.entries) {
      expect(e.installable).toBe(false);
      expect(e.reason).toBe(ENTRY_REASONS.UNSUPPORTED_SOURCE);
    }
  });

  it('refuses unsafe relative paths and bad entries per entry, not for the file', () => {
    const m = ok({
      name: 'm',
      plugins: [
        { name: 'a', source: '../escape' },
        { name: 'b', source: '/abs' },
        { name: 'c', source: 'a\\b' },
        { name: 'bad name!', source: './x' },
        { name: 'd' },
        'nope',
        { name: 'e', source: { repo: 'not-a-repo', source: 'github' } },
        { name: 'f', source: { repo: 'a/b', sha: 'zz', source: 'github' } },
        { name: 'g', source: { path: '../x', repo: 'a/b', source: 'github' } },
        { name: 'h', source: './fine' },
      ],
    });
    expect(m.entries.map((e) => [e.name, e.installable, e.reason])).toEqual([
      ['a', false, ENTRY_REASONS.INVALID_PATH],
      ['b', false, ENTRY_REASONS.INVALID_PATH],
      ['c', false, ENTRY_REASONS.INVALID_PATH],
      [null, false, ENTRY_REASONS.INVALID_ENTRY],
      ['d', false, ENTRY_REASONS.INVALID_ENTRY],
      [null, false, ENTRY_REASONS.INVALID_ENTRY],
      ['e', false, ENTRY_REASONS.INVALID_REPO],
      ['f', false, ENTRY_REASONS.INVALID_REPO],
      ['g', false, ENTRY_REASONS.INVALID_PATH],
      ['h', true, null],
    ]);
  });

  it('marks duplicate names (case-insensitive) not installable', () => {
    const m = ok({
      name: 'm',
      plugins: [
        { name: 'Dup', source: './a' },
        { name: 'dup', source: './b' },
        { name: 'one', source: './c' },
      ],
    });
    expect(m.entries.map((e) => e.installable)).toEqual([false, false, true]);
    expect(m.entries[0]?.reason).toBe(ENTRY_REASONS.DUPLICATE_NAME);
  });

  it('prepends metadata.pluginRoot to relative sources', () => {
    const m = ok({
      metadata: { pluginRoot: './plugins' },
      name: 'm',
      plugins: [
        { name: 'a', source: 'a' },
        { name: 'b', source: './b' },
      ],
    });
    expect(m.entries.map((e) => e.source)).toEqual([
      { kind: 'relative', path: 'plugins/a' },
      { kind: 'relative', path: 'plugins/b' },
    ]);
  });

  it('replaces control characters in shown text', () => {
    const m = ok({
      name: 'm\u001b[31m',
      plugins: [{ description: 'd‮\u0007x', name: 'a', source: './a' }],
    });
    expect(m.name).toBe('m?[31m');
    expect(m.entries[0]?.description).toBe('d??x');
  });

  it.each([
    ['not json', '{'],
    ['no plugins', { name: 'm' }],
    ['no name', { plugins: [] }],
    ['plugins wrong type', { name: 'm', plugins: {} }],
    ['array', []],
  ])('rejects %s with a fixed sentence', (_l, v) => {
    const r = parse(v);
    expect(r.ok).toBe(false);
  });

  it('rejects a file over the size limit and invalid UTF-8', () => {
    expect(parseMarketplace(Buffer.alloc(1_000_001, 32)).ok).toBe(false);
    expect(parseMarketplace(Buffer.from([0xff, 0xfe])).ok).toBe(false);
  });

  it('rejects more than 500 entries', () => {
    const plugins = Array.from({ length: 501 }, (_, i) => ({ name: `p${i}`, source: './x' }));
    expect(parse({ name: 'm', plugins }).ok).toBe(false);
  });
});
