import { describe, expect, it } from 'vitest';
import {
  buildAllowlist,
  LockfileParseError,
  packageManagerPins,
  parseLockfile,
} from './lockfileAllowlist.js';

describe('parseLockfile: package-lock.json', () => {
  it('reads v2/v3 packages, skipping the root and links', () => {
    const entries = parseLockfile(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'app', version: '0.0.0' },
          'node_modules/@acme/lib': { name: '@acme/lib', version: '1.2.3' },
          'node_modules/left-pad': { version: '1.3.0' },
          'node_modules/local-link': { link: true, resolved: '../lib' },
          'node_modules/nested/node_modules/inner': { version: '2.0.0' },
        },
      })
    );
    expect(entries).toEqual([
      { name: '@acme/lib', version: '1.2.3' },
      { name: 'left-pad', version: '1.3.0' },
      { name: 'inner', version: '2.0.0' },
    ]);
  });

  it('walks a v1 dependencies tree', () => {
    const entries = parseLockfile(
      'package-lock.json',
      JSON.stringify({
        dependencies: {
          a: { dependencies: { b: { version: '2.0.0' } }, version: '1.0.0' },
        },
        lockfileVersion: 1,
      })
    );
    expect(entries).toEqual([
      { name: 'a', version: '1.0.0' },
      { name: 'b', version: '2.0.0' },
    ]);
  });
});

describe('parseLockfile: yarn.lock', () => {
  it('parses classic v1 entries incl. scoped and quoted names', () => {
    const entries = parseLockfile(
      'yarn.lock',
      `# yarn lockfile v1

left-pad@^1.3.0:
  version "1.3.0"

"@acme/lib@npm:^2.0.0", "@acme/lib@npm:^2.1.0":
  version "2.1.4"
`
    );
    expect(entries).toEqual([
      { name: 'left-pad', version: '1.3.0' },
      { name: '@acme/lib', version: '2.1.4' },
    ]);
  });

  it('parses Berry resolutions, skipping workspace:/patch: protocols', () => {
    const entries = parseLockfile(
      'yarn.lock',
      `__metadata:
  version: 8

"left-pad@npm:^1.3.0":
  resolution: "left-pad@npm:1.3.0"

"@acme/lib@workspace:packages/lib":
  resolution: "@acme/lib@workspace:packages/lib"

"dep@patch:dep@npm%3A1.0.0#./fix.patch":
  resolution: "dep@patch:dep@npm:1.0.0#./fix.patch"
`
    );
    expect(entries).toEqual([{ name: 'left-pad', version: '1.3.0' }]);
  });
});

describe('parseLockfile: pnpm-lock.yaml', () => {
  it('parses v9 keys and strips peer suffixes', () => {
    const entries = parseLockfile(
      'pnpm-lock.yaml',
      `lockfileVersion: '9.0'
packages:
  left-pad@1.3.0: {}
  '@scope/pkg@2.0.0(react@19.0.0)': {}
`
    );
    expect(entries).toEqual([
      { name: 'left-pad', version: '1.3.0' },
      { name: '@scope/pkg', version: '2.0.0' },
    ]);
  });

  it('parses v5 keys with peer suffixes after the version', () => {
    const entries = parseLockfile(
      'pnpm-lock.yaml',
      `lockfileVersion: 5.4
packages:
  /left-pad/1.3.0: {}
  /@scope/pkg/2.0.0_react@17.0.2: {}
`
    );
    expect(entries).toEqual([
      { name: 'left-pad', version: '1.3.0' },
      { name: '@scope/pkg', version: '2.0.0' },
    ]);
  });

  it('parses v6 /name/ver keys', () => {
    const entries = parseLockfile(
      'pnpm-lock.yaml',
      `lockfileVersion: '6.0'
packages:
  /left-pad/1.3.0: {}
  /@scope/pkg/2.0.0(react@19.0.0): {}
`
    );
    expect(entries).toEqual([
      { name: 'left-pad', version: '1.3.0' },
      { name: '@scope/pkg', version: '2.0.0' },
    ]);
  });
});

describe('parseLockfile errors and buildAllowlist', () => {
  it('throws LockfileParseError on malformed content and unknown files', () => {
    expect(() => parseLockfile('package-lock.json', 'not json')).toThrow(LockfileParseError);
    expect(() => parseLockfile('random.txt', 'x')).toThrow(LockfileParseError);
    expect(() => parseLockfile('yarn.lock', 'not a lockfile')).toThrow(LockfileParseError);
  });

  it('builds a name → versions map', () => {
    const map = buildAllowlist([
      { name: 'a', version: '1' },
      { name: 'a', version: '2' },
      { name: 'b', version: '3' },
    ]);
    expect(map.get('a')).toEqual(new Set(['1', '2']));
    expect(map.get('b')).toEqual(new Set(['3']));
  });
});

describe('packageManagerPins', () => {
  it('maps each packageManager pin to its npm package', () => {
    expect(packageManagerPins('{"packageManager":"pnpm@10.34.7"}')).toEqual([
      { name: 'pnpm', version: '10.34.7' },
    ]);
    expect(packageManagerPins('{"packageManager":"yarn@1.22.22"}')).toEqual([
      { name: 'yarn', version: '1.22.22' },
    ]);
    expect(packageManagerPins('{"packageManager":"yarn@4.18.1+sha224.abc"}')).toEqual([
      { name: '@yarnpkg/cli-dist', version: '4.18.1' },
    ]);
    expect(packageManagerPins('{"packageManager":"npm@11.9.0"}')).toEqual([
      { name: 'npm', version: '11.9.0' },
    ]);
  });
  it('returns [] for missing or invalid input', () => {
    expect(packageManagerPins('{}')).toEqual([]);
    expect(packageManagerPins('not json')).toEqual([]);
    expect(packageManagerPins('{"packageManager":"bun@1.0"}')).toEqual([]);
    expect(packageManagerPins('{"packageManager":"npm@latest"}')).toEqual([]);
  });
});
