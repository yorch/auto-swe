import { describe, expect, it } from 'vitest';
import {
  buildPypiAllowlist,
  isPypiAllowed,
  isValidPypiName,
  normalizePypiName,
  normalizePypiVersion,
  PYPI_LOCKFILE_NAMES,
  parsePipfileLock,
  parsePoetryLock,
  parsePylockToml,
  parsePypiFilename,
  parsePypiLockfile,
  parseRequirementsTxt,
  parseUvLock,
} from './pypiAllowlist.js';

describe('names', () => {
  it('normalises per PEP 503', () => {
    expect(normalizePypiName('Foo_Bar.baz--Qux')).toBe('foo-bar-baz-qux');
    expect(normalizePypiName('zope.interface')).toBe('zope-interface');
  });

  it('validates', () => {
    expect(isValidPypiName('Django')).toBe(true);
    expect(isValidPypiName('a')).toBe(true);
    expect(isValidPypiName('')).toBe(false);
    expect(isValidPypiName('-a')).toBe(false);
    expect(isValidPypiName('a/b')).toBe(false);
    expect(isValidPypiName('a b')).toBe(false);
    expect(isValidPypiName('a'.repeat(201))).toBe(false);
  });
});

describe('normalizePypiVersion', () => {
  it.each([
    ['1.0.0', '1'],
    ['1.10', '1.10'],
    ['0.0', '0'],
    ['1.0.0rc1', '1rc1'],
    ['1.0.0-rc.1', '1rc1'],
    ['1.0.0RC1', '1rc1'],
    ['1.0a1', '1a1'],
    ['1.0alpha', '1a0'],
    ['1.0beta2', '1b2'],
    ['1.0c1', '1rc1'],
    ['1.0pre1', '1rc1'],
    ['1.0preview2', '1rc2'],
    ['1.0.post1', '1.post1'],
    ['1.0-1', '1.post1'],
    ['1.0rev2', '1.post2'],
    ['1.0r3', '1.post3'],
    ['1.0.post', '1.post0'],
    ['1.0.dev3', '1.dev3'],
    ['1.0dev', '1.dev0'],
    ['1.0a1.post2.dev3', '1a1.post2.dev3'],
    ['2.0.0+Ubuntu_1', '2+ubuntu.1'],
    ['2.0+abc-01', '2+abc.1'],
    ['1!2.0', '1!2'],
    ['0!2.0', '2'],
    ['v3.1', '3.1'],
    ['1.01.0', '1.1'],
    ['1_0', null],
  ] as const)('%s -> %s', (input, expected) => {
    expect(normalizePypiVersion(input)).toBe(expected);
  });

  it.each([
    '',
    'junk',
    '1.*',
    '1.0.*',
    '1.0,<2',
    '>=1.0',
    '1..0',
    '1.0 ',
    ' 1.0',
    '1.0+',
    '1.0+a..b',
    '1.0.0.0.',
    '1.0xyz',
    'latest',
    '1'.repeat(200),
  ])('refuses %j', (input) => {
    expect(normalizePypiVersion(input)).toBeNull();
  });

  it('keeps distinct versions distinct', () => {
    expect(normalizePypiVersion('1.0')).not.toBe(normalizePypiVersion('1.0.1'));
    expect(normalizePypiVersion('1.0a1')).not.toBe(normalizePypiVersion('1.0b1'));
    expect(normalizePypiVersion('1.0')).not.toBe(normalizePypiVersion('1.0.post0'));
    expect(normalizePypiVersion('1.0')).not.toBe(normalizePypiVersion('1.0+local'));
    expect(normalizePypiVersion('1.0')).not.toBe(normalizePypiVersion('1.0.dev0'));
    expect(normalizePypiVersion('1.0')).not.toBe(normalizePypiVersion('1!1.0'));
  });
});

describe('parsePypiFilename', () => {
  it('reads a wheel', () => {
    expect(parsePypiFilename('requests-2.31.0-py3-none-any.whl')).toEqual({
      name: 'requests',
      version: '2.31',
    });
  });

  it('reads a wheel with a build tag and an escaped name', () => {
    expect(parsePypiFilename('My_Pkg.Name-1.0.0-1-cp312-cp312-manylinux_2_17_x86_64.whl')).toEqual({
      name: 'my-pkg-name',
      version: '1',
    });
  });

  it('refuses a wheel with the wrong number of parts or a bad build tag', () => {
    expect(parsePypiFilename('a-1.0-py3-none.whl')).toBeNull();
    expect(parsePypiFilename('a-1.0-x-py3-none-any.whl')).toBeNull();
    expect(parsePypiFilename('a-1.0-1-py3-none-any-extra.whl')).toBeNull();
  });

  it('reads sdists', () => {
    expect(parsePypiFilename('requests-2.31.0.tar.gz')).toEqual({
      name: 'requests',
      version: '2.31',
    });
    expect(parsePypiFilename('Foo_Bar-1.0rc1.zip')).toEqual({ name: 'foo-bar', version: '1rc1' });
    expect(parsePypiFilename('x-1.0.tar.bz2')?.version).toBe('1');
    expect(parsePypiFilename('x-1.0.tar.xz')?.version).toBe('1');
    expect(parsePypiFilename('x-1.0.tgz')?.version).toBe('1');
  });

  it('splits a legacy sdist name that holds a dash', () => {
    expect(parsePypiFilename('python-dateutil-2.8.2.tar.gz')).toEqual({
      name: 'python-dateutil',
      version: '2.8.2',
    });
    expect(parsePypiFilename('my-pkg-v2-1.4.tar.gz')).toEqual({
      name: 'my-pkg-v2',
      version: '1.4',
    });
  });

  it('refuses other kinds of file', () => {
    expect(parsePypiFilename('foo-1.0-py3.12.egg')).toBeNull();
    expect(parsePypiFilename('foo-1.0.win32.exe')).toBeNull();
    expect(parsePypiFilename('foo-1.0.rpm')).toBeNull();
    expect(parsePypiFilename('foo.tar.gz')).toBeNull();
    expect(parsePypiFilename('1.0.tar.gz')).toBeNull();
    expect(parsePypiFilename('')).toBeNull();
  });

  it('survives hostile input in linear time', () => {
    const started = Date.now();
    expect(parsePypiFilename(`${'a-'.repeat(1_000)}.tar.gz`)).toBeNull();
    expect(parsePypiFilename(`${'a-1'.repeat(100)}.tar.gz`)).toBeNull();
    expect(parsePypiFilename(`${'a-'.repeat(90)}1.tar.gz`)).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
});

const UV_LOCK = `version = 1
revision = 2
requires-python = ">=3.11"
resolution-markers = [
    "python_full_version >= '3.12'",
]

[manifest]
members = ["app"]

[[package]]
name = "app"
version = "0.1.0"
source = { editable = "." }
dependencies = [
    { name = "requests" },
]

[package.metadata]
requires-dist = [{ name = "requests", specifier = ">=2" }]

[[package]]
name = "Requests"
version = "2.31.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "urllib3" },
]
sdist = { url = "https://files.pythonhosted.org/requests-2.31.0.tar.gz", hash = "sha256:aa", size = 1 }
wheels = [
    { url = "https://files.pythonhosted.org/requests-2.31.0-py3-none-any.whl", hash = "sha256:bb", size = 2 },
]

[package.optional-dependencies]
socks = [
    { name = "pysocks" },
]

[[package]]
name = "urllib3"
version = "2.2.1"
source = { registry = "https://pypi.org/simple" }

[[package.wheels]]
name = "evil"
version = "9.9.9"

[package.dependencies]
version = "8.8.8"

[[package]]
name = "gitpkg"
version = "1.2.3"
source = { git = "https://github.com/x/gitpkg?rev=abc#abc" }

[[package]]
name = "urlpkg"
version = "4.0"
source = { url = "https://example.com/urlpkg-4.0.tar.gz" }

[[package]]
name = "pathpkg"
version = "5.0"
source = { path = "../pathpkg" }

[[package]]
name = "dirpkg"
version = "6.0"
source = { directory = "../dirpkg" }

[[package]]
name = "virt"
version = "7.0"
source = { virtual = "." }
`;

describe('parseUvLock', () => {
  it('keeps index packages and ignores sub-tables and non-index sources', () => {
    expect(parseUvLock(UV_LOCK)).toEqual([
      { name: 'requests', version: '2.31' },
      { name: 'urllib3', version: '2.2.1' },
    ]);
  });

  it('does not read the top-level `version = 1`', () => {
    expect(parseUvLock('version = 1\n')).toEqual([]);
  });
});

const POETRY_LOCK = `# This file is automatically @generated by Poetry 1.8 and should not be changed by hand.

[[package]]
name = "certifi"
version = "2024.2.2"
description = "Python package for providing Mozilla's CA Bundle."
optional = false
python-versions = ">=3.6"
files = [
    {file = "certifi-2024.2.2-py3-none-any.whl", hash = "sha256:dc"},
]

[[package]]
name = "mylib"
version = "0.3.0"
description = ""
optional = false
python-versions = "*"
files = []
develop = false

[package.dependencies]
version = "1.0"

[package.source]
type = "git"
url = "https://github.com/x/mylib.git"
reference = "main"
resolved_reference = "abcdef"

[[package]]
name = "internal"
version = "1.0.0"
description = ""
optional = false
python-versions = "*"
files = []

[package.source]
type = "legacy"
url = "https://pypi.example.com/simple"
reference = "internal"

[[package]]
name = "localdir"
version = "0.1.0"
files = []

[package.source]
type = "directory"
url = "../localdir"

[[package]]
name = "Zope.Interface"
version = "6.2"
files = []

[package.extras]
docs = ["sphinx"]

[metadata]
lock-version = "2.0"
python-versions = "^3.11"
content-hash = "abc"
`;

describe('parsePoetryLock', () => {
  it('skips git/directory/file/url sources and keeps legacy indexes', () => {
    expect(parsePoetryLock(POETRY_LOCK)).toEqual([
      { name: 'certifi', version: '2024.2.2' },
      { name: 'internal', version: '1' },
      { name: 'zope-interface', version: '6.2' },
    ]);
  });

  it('does not read the metadata table', () => {
    expect(parsePoetryLock('[metadata]\nversion = "1.0"\nname = "x"\n')).toEqual([]);
  });
});

const PYLOCK = `lock-version = "1.0"
created-by = "pip"

[[packages]]
name = "attrs"
version = "23.2.0"
index = "https://pypi.org/simple"

[[packages.wheels]]
name = "attrs-23.2.0-py3-none-any.whl"
url = "https://files/attrs.whl"

[packages.wheels.hashes]
sha256 = "aa"

[[packages]]
name = "vcsdep"
version = "1.0"

[packages.vcs]
type = "git"
url = "https://github.com/x/y"

[[packages]]
name = "localdep"
version = "2.0"

[packages.directory]
path = "."

[[packages]]
name = "archived"
version = "3.0"

[packages.archive]
url = "https://example.com/a.tar.gz"
`;

describe('parsePylockToml', () => {
  it('reads [[packages]] and skips vcs, directory and archive', () => {
    expect(parsePylockToml(PYLOCK)).toEqual([{ name: 'attrs', version: '23.2' }]);
  });
});

const REQUIREMENTS = `# a comment
--index-url https://example.com/simple
-r other.txt
-e .
requests==2.31.0 \\
    --hash=sha256:aaaa \\
    --hash=sha256:bbbb
Flask[async]==3.0.0 ; python_version >= "3.8"   # trailing comment
numpy === 1.26.4
pandas==2.1.*
django>=4.0
six~=1.16
attrs!=1.0
click<9
rich
mylib @ https://example.com/mylib-1.0.tar.gz
git+https://github.com/x/y.git#egg=y
pytest==8.0.0 --hash=sha256:cc
Jinja2 == 3.1.3
bad==not-a-version
`;

describe('parseRequirementsTxt', () => {
  it('reads exact pins and nothing else', () => {
    expect(parseRequirementsTxt(REQUIREMENTS)).toEqual([
      { name: 'requests', version: '2.31' },
      { name: 'flask', version: '3' },
      { name: 'numpy', version: '1.26.4' },
      { name: 'pytest', version: '8' },
      { name: 'jinja2', version: '3.1.3' },
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseRequirementsTxt('a==1.0\r\nb==2.0\r\n')).toEqual([
      { name: 'a', version: '1' },
      { name: 'b', version: '2' },
    ]);
  });
});

describe('parsePipfileLock', () => {
  const doc = JSON.stringify({
    _meta: { hash: { sha256: 'x' } },
    default: {
      arbitrary: { version: '===3.0' },
      Flask_Login: { index: 'pypi', version: '==0.6.3' },
      filedep: { file: 'https://x/y.tar.gz', version: '==2.0' },
      gitdep: { git: 'https://github.com/x/y', ref: 'abc', version: '==1.0' },
      localdep: { editable: true, path: '.' },
      loose: { version: '>=1.0' },
      nover: {},
      requests: { hashes: ['sha256:aa'], version: '==2.31.0' },
    },
    develop: {
      pytest: { version: '==8.0.0' },
    },
  });

  it('reads == pins from default and develop', () => {
    const got = parsePipfileLock(doc);
    expect(got).toHaveLength(3);
    expect(got).toEqual(
      expect.arrayContaining([
        { name: 'requests', version: '2.31' },
        { name: 'flask-login', version: '0.6.3' },
        { name: 'pytest', version: '8' },
      ])
    );
  });

  it('is empty on malformed or unexpected JSON', () => {
    expect(parsePipfileLock('{nope')).toEqual([]);
    expect(parsePipfileLock('[]')).toEqual([]);
    expect(parsePipfileLock('null')).toEqual([]);
    expect(parsePipfileLock('{"default": []}')).toEqual([]);
  });
});

describe('parsePypiLockfile', () => {
  it('dispatches on the basename', () => {
    expect(PYPI_LOCKFILE_NAMES).toContain('uv.lock');
    expect(parsePypiLockfile('services/api/uv.lock', UV_LOCK)).toHaveLength(2);
    expect(parsePypiLockfile('poetry.lock', POETRY_LOCK)).toHaveLength(3);
    expect(parsePypiLockfile('pylock.toml', PYLOCK)).toHaveLength(1);
    expect(parsePypiLockfile('pylock.dev.toml', PYLOCK)).toHaveLength(1);
    expect(parsePypiLockfile('Pipfile.lock', '{"default":{"a":{"version":"==1"}}}')).toHaveLength(
      1
    );
    expect(parsePypiLockfile('requirements.txt', 'a==1')).toHaveLength(1);
    expect(parsePypiLockfile('deploy\\requirements-dev.txt', 'a==1')).toHaveLength(1);
    expect(parsePypiLockfile('requirements_test.v2.txt', 'a==1')).toHaveLength(1);
  });

  it('ignores other names', () => {
    expect(parsePypiLockfile('package-lock.json', 'a==1')).toEqual([]);
    expect(parsePypiLockfile('requirements.txt.bak', 'a==1')).toEqual([]);
    expect(parsePypiLockfile('xrequirements.txt', 'a==1')).toEqual([]);
    expect(parsePypiLockfile('pylock.toml.orig', PYLOCK)).toEqual([]);
  });
});

describe('bounds', () => {
  it('refuses oversize text', () => {
    const big = `${'#'.repeat(1024)}\n`.repeat(8 * 1024 + 1);
    expect(big.length).toBeGreaterThan(8 * 1024 * 1024);
    expect(parseRequirementsTxt(`a==1\n${big}`)).toEqual([]);
    expect(parseUvLock(`[[package]]\nname = "a"\nversion = "1"\n${big}`)).toEqual([]);
    expect(parsePoetryLock(big)).toEqual([]);
    expect(parsePylockToml(big)).toEqual([]);
    expect(parsePipfileLock(big)).toEqual([]);
  });

  it('caps the number of entries', () => {
    const text = Array.from({ length: 50_100 }, (_, i) => `p${i}==1.${i}`).join('\n');
    expect(parseRequirementsTxt(text)).toHaveLength(50_000);
    const toml = Array.from(
      { length: 50_100 },
      (_, i) => `[[package]]\nname = "p${i}"\nversion = "1.${i}"\n`
    ).join('\n');
    expect(parseUvLock(toml)).toHaveLength(50_000);
  });

  it('skips over-long lines', () => {
    const long = `${'a'.repeat(2_001)}==1.0`;
    expect(parseRequirementsTxt(`${long}\nb==2.0`)).toEqual([{ name: 'b', version: '2' }]);
    const toml = `[[package]]\nname = "${'a'.repeat(2_001)}"\nversion = "1"\n`;
    expect(parseUvLock(toml)).toEqual([]);
  });

  it('reads a 2,000-character hostile line in linear time', () => {
    const line = 'a-'.repeat(1_000);
    const started = Date.now();
    expect(parseRequirementsTxt(`${line}==1.0`)).toEqual([]);
    expect(parseRequirementsTxt(`${line.slice(0, 1_990)}==1.0`)).toEqual([]);
    expect(parseUvLock(`[[package]]\nname = "${line.slice(0, 1_900)}"\nversion = "1"\n`)).toEqual(
      []
    );
    expect(normalizePypiVersion(`${'1.'.repeat(60)}x`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe('allowlist', () => {
  const list = buildPypiAllowlist([
    ...parseUvLock(UV_LOCK),
    ...parseRequirementsTxt('Django==4.2.0rc1\nDjango==4.2.0'),
  ]);

  it('matches on normalised name and canonical version', () => {
    expect(isPypiAllowed(list, 'REQUESTS', '2.31.0')).toBe(true);
    expect(isPypiAllowed(list, 'requests', '2.31')).toBe(true);
    expect(isPypiAllowed(list, 'django', '4.2.0-rc.1')).toBe(true);
    expect(isPypiAllowed(list, 'Django', '4.2')).toBe(true);
  });

  it('refuses everything else', () => {
    expect(isPypiAllowed(list, 'requests', '2.31.1')).toBe(false);
    expect(isPypiAllowed(list, 'requests', '2.31.0.post1')).toBe(false);
    expect(isPypiAllowed(list, 'gitpkg', '1.2.3')).toBe(false);
    expect(isPypiAllowed(list, 'requests', 'junk')).toBe(false);
    expect(isPypiAllowed(list, '../requests', '2.31.0')).toBe(false);
    expect(isPypiAllowed(list, '', '2.31.0')).toBe(false);
    expect(isPypiAllowed(new Map(), 'requests', '2.31.0')).toBe(false);
  });

  it('drops invalid requirements when building', () => {
    const built = buildPypiAllowlist([
      { name: 'ok', version: '1.0' },
      { name: 'bad name', version: '1.0' },
      { name: 'ok2', version: 'nope' },
    ]);
    expect([...built.keys()]).toEqual(['ok']);
  });
});
