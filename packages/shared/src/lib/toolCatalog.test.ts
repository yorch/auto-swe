import { describe, expect, it } from 'vitest';
import {
  assertValidEntry,
  BUILTIN_TOOLS,
  compareVersions,
  RESERVED_TOOL_KEYS,
  resolveToolRequests,
  type ToolCatalogEntry,
  type ToolCatalogRow,
  ToolInstallError,
  toToolCatalogEntry,
} from './toolCatalog.js';

const DOWNLOAD = {
  sha256: 'a'.repeat(64),
  url: 'https://example.com/jq-1.0.0.tar.gz',
};

const entry = (overrides: Partial<ToolCatalogEntry>): ToolCatalogEntry => ({
  archs: { amd64: DOWNLOAD },
  key: 'jq',
  libc: 'any',
  member: 'jq',
  status: 'ACTIVE',
  version: '1.0.0',
  ...overrides,
});

const row = (overrides: Partial<ToolCatalogRow>): ToolCatalogRow => ({
  archs: { amd64: DOWNLOAD },
  description: null,
  key: 'jq',
  libc: 'any',
  member: 'jq',
  status: 'ACTIVE',
  version: '1.0.0',
  ...overrides,
});

const catchError = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
};

describe('resolveToolRequests', () => {
  const catalog = [
    entry({ version: '1.9.0' }),
    entry({ version: '1.10.0' }),
    entry({ status: 'REVOKED', version: '2.0.0' }),
    entry({ status: 'DEPRECATED', version: '1.5.0' }),
  ];

  it('picks the row an explicit version names', () => {
    const [resolved] = resolveToolRequests([{ key: 'jq', version: '1.9.0' }], catalog);
    expect(resolved?.entry.version).toBe('1.9.0');
    expect(resolved?.warning).toBeUndefined();
  });

  it('picks the highest ACTIVE version when the version is omitted, numeric-aware (1.10.0 over 1.9.0)', () => {
    const [resolved] = resolveToolRequests([{ key: 'jq' }], catalog);
    expect(resolved?.entry.version).toBe('1.10.0');
  });

  it('skips DEPRECATED and REVOKED rows when the version is omitted', () => {
    const rows = [
      entry({ version: '1.0.0' }),
      entry({ status: 'REVOKED', version: '3.0.0' }),
      entry({ status: 'DEPRECATED', version: '2.0.0' }),
    ];
    const [resolved] = resolveToolRequests([{ key: 'jq' }], rows);
    expect(resolved?.entry.version).toBe('1.0.0');
  });

  it('throws a non-retryable ToolInstallError naming key@version for an explicit REVOKED row', () => {
    const error = catchError(() => resolveToolRequests([{ key: 'jq', version: '2.0.0' }], catalog));
    expect(error).toBeInstanceOf(ToolInstallError);
    expect((error as ToolInstallError).message).toMatch(/jq@2\.0\.0/);
    expect((error as ToolInstallError).retryable).toBe(false);
  });

  it('returns a warning for an explicit DEPRECATED row', () => {
    const [resolved] = resolveToolRequests([{ key: 'jq', version: '1.5.0' }], catalog);
    expect(resolved?.entry.version).toBe('1.5.0');
    expect(resolved?.warning).toMatch(/jq@1\.5\.0/);
    expect(resolved?.warning).toMatch(/deprecated/);
  });

  it('throws a ToolInstallError for an unknown key', () => {
    expect(() => resolveToolRequests([{ key: 'nope' }], catalog)).toThrow(ToolInstallError);
  });

  it('throws a ToolInstallError for an unknown version of a known key', () => {
    expect(() => resolveToolRequests([{ key: 'jq', version: '9.9.9' }], catalog)).toThrow(
      ToolInstallError
    );
  });
});

describe('toToolCatalogEntry', () => {
  it('parses a valid row', () => {
    expect(toToolCatalogEntry(row({ description: 'A JSON processor' }))).toEqual({
      archs: { amd64: DOWNLOAD },
      description: 'A JSON processor',
      key: 'jq',
      libc: 'any',
      member: 'jq',
      status: 'ACTIVE',
      version: '1.0.0',
    });
  });

  it.each<[string, Partial<ToolCatalogRow>]>([
    [
      'an http:// download url',
      { archs: { amd64: { ...DOWNLOAD, url: 'http://example.com/jq.tar.gz' } } },
    ],
    ['a 63-character sha256', { archs: { amd64: { ...DOWNLOAD, sha256: 'a'.repeat(63) } } }],
    ['an uppercase sha256', { archs: { amd64: { ...DOWNLOAD, sha256: 'A'.repeat(64) } } }],
    ['an empty archs object', { archs: {} }],
    ['an unknown arch key', { archs: { riscv64: DOWNLOAD } }],
    ['a member containing ..', { member: '../jq' }],
    ['a member with a leading /', { member: '/jq' }],
    ['a member containing a space', { member: 'my tool' }],
    ['a key with uppercase letters', { key: 'Jq' }],
    ['a key with shell metacharacters', { key: 'jq;rm' }],
    ['an unknown libc', { libc: 'gnu' }],
  ])('throws a ToolInstallError for %s', (_label, overrides) => {
    expect(() => toToolCatalogEntry(row(overrides))).toThrow(ToolInstallError);
  });
});

describe('BUILTIN_TOOLS', () => {
  it('ships at least one tool', () => {
    expect(BUILTIN_TOOLS.length).toBeGreaterThan(0);
  });

  it('has every entry passing assertValidEntry', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(() => assertValidEntry(tool)).not.toThrow();
    }
  });

  it('has a unique key@version for every entry', () => {
    const names = BUILTIN_TOOLS.map((tool) => `${tool.key}@${tool.version}`);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('archive member', () => {
  it.each(['just', 'bin/just', 'a_b/c-d.e'])('accepts %s', (member) => {
    expect(() => toToolCatalogEntry(row({ member }))).not.toThrow();
  });

  it.each([
    '-P',
    '--overwrite',
    '--absolute-names',
    '.',
    'a/./b',
    'a/../b',
    '..',
    '/abs',
    'a/',
    'a//b',
    '',
    'a b',
    'a\nb',
  ])('rejects %j', (member) => {
    expect(() => toToolCatalogEntry(row({ member }))).toThrow(ToolInstallError);
  });
});

describe('download url', () => {
  const withUrl = (url: string) => row({ archs: { amd64: { ...DOWNLOAD, url } } });

  it.each(['https://example.com/a/b.tar.gz', 'https://example.com:8443/a-b_c.1/x.tar.gz'])(
    'accepts %s',
    (url) => {
      expect(() => toToolCatalogEntry(withUrl(url))).not.toThrow();
    }
  );

  it.each([
    ['userinfo', 'https://u:p@example.com/x.tar.gz'],
    ['username only', 'https://token@example.com/x.tar.gz'],
    ['query', 'https://example.com/x.tar.gz?token=abc'],
    ['empty query', 'https://example.com/x.tar.gz?'],
    ['fragment', 'https://example.com/x.tar.gz#frag'],
    ['newline', 'https://example.com/x\n.tar.gz'],
    ['space', 'https://example.com/x y.tar.gz'],
    ['tab', 'https://example.com/x\t.tar.gz'],
    ['backtick', 'https://example.com/`id`.tar.gz'],
    ['command substitution', 'https://example.com/$(id).tar.gz'],
    ['double quote', 'https://example.com/x".tar.gz'],
    ['single quote', "https://example.com/x'.tar.gz"],
    ['backslash', 'https://example.com/x\\y.tar.gz'],
    ['non-ASCII', 'https://example.com/café.tar.gz'],
    ['bare scheme', 'https://'],
    ['no host', 'https:///x.tar.gz'],
    ['http', 'http://example.com/x.tar.gz'],
    ['too long', `https://example.com/${'a'.repeat(2000)}`],
    ['curl glob braces', 'https://example.com/{a,b}.tar.gz'],
    ['curl glob range', 'https://example.com/x[1-3].tar.gz'],
    ['IPv6 literal', 'https://[::1]/x.tar.gz'],
    ['IPv4 literal', 'https://169.254.169.254/x.tar.gz'],
    ['hex IPv4', 'https://0x7f.1/x.tar.gz'],
    ['decimal IPv4', 'https://2130706433/x.tar.gz'],
    ['localhost', 'https://localhost/x.tar.gz'],
    ['a .localhost name', 'https://app.localhost/x.tar.gz'],
    ['a .internal name', 'https://mirror.internal/x.tar.gz'],
    ['a dotless host', 'https://mirror/x.tar.gz'],
    ['a trailing dot', 'https://example.com./x.tar.gz'],
    ['a leading-dash label', 'https://-a.example.com/x.tar.gz'],
    ['a semicolon in the host', 'https://a;b.example.com/x.tar.gz'],
    ['port 0', 'https://example.com:0/x.tar.gz'],
  ])('rejects %s', (_label, url) => {
    expect(() => toToolCatalogEntry(withUrl(url))).toThrow(ToolInstallError);
  });
});

describe('description', () => {
  it('rejects a control character', () => {
    expect(() => toToolCatalogEntry(row({ description: 'line one\nline two' }))).toThrow(
      ToolInstallError
    );
    expect(() => toToolCatalogEntry(row({ description: 'esc\u001b[31m' }))).toThrow(
      ToolInstallError
    );
  });
});

describe('reserved keys', () => {
  it('exports the platform program names and refuses them as a catalog key', () => {
    for (const key of ['git', 'sh', 'env', 'tar', 'curl', 'docker', 'base64']) {
      expect(RESERVED_TOOL_KEYS.has(key)).toBe(true);
      expect(() => toToolCatalogEntry(row({ key }))).toThrow(/reserved/);
      expect(() => assertValidEntry(entry({ key }))).toThrow(/reserved/);
    }
  });

  it('allows an ordinary key', () => {
    expect(() => toToolCatalogEntry(row({ key: 'just' }))).not.toThrow();
  });
});

describe('compareVersions and omitted-version resolution', () => {
  const pick = (versions: string[]) =>
    resolveToolRequests(
      [{ key: 'jq' }],
      versions.map((version) => entry({ version }))
    )[0]?.entry.version;

  it.each([
    [['1.0.0-rc1', '1.0.0'], '1.0.0'],
    [['2.0.0-beta', '1.9.9'], '1.9.9'],
    [['v1.9', '1.10'], '1.10'],
    [['1.9.0', '1.10.0'], '1.10.0'],
    [['1.0.0-alpha', '1.0.0-beta'], '1.0.0-beta'],
    [['1.0.0-rc.2', '1.0.0-rc.10'], '1.0.0-rc.10'],
    [['1.0.0-1', '1.0.0-alpha'], '1.0.0-alpha'],
    [['1.0', '1.0.1'], '1.0.1'],
    [['1.0.0+build9', '1.0.1'], '1.0.1'],
    [['1.2.3', 'nightly'], '1.2.3'],
    [['1.0.0-rc.1', '1.0.0-rc.2'], '1.0.0-rc.2'],
  ])('%j resolves to %s', (versions, expected) => {
    expect(pick(versions)).toBe(expected);
    expect(pick([...versions].reverse())).toBe(expected);
  });

  it('treats build metadata and a leading v as equal', () => {
    expect(compareVersions('v1.2.3+a', '1.2.3+b')).toBe(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});
