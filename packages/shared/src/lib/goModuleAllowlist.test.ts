import { describe, expect, it } from 'vitest';
import {
  buildGoAllowlist,
  GO_SUM_NAME,
  isValidGoModulePath,
  isValidGoVersion,
  parseGoSum,
} from './goModuleAllowlist.js';

const H = 'h1:Zk9oB1xq3YxQb0m8r4K3tq8o1P0lq4vV2m5z7W9y8X0=';

const GO_SUM = [
  `github.com/Azure/go-autorest v14.2.0+incompatible ${H}`,
  `github.com/Azure/go-autorest v14.2.0+incompatible/go.mod ${H}`,
  `golang.org/x/text v0.14.0 ${H}`,
  `golang.org/x/text v0.14.0/go.mod ${H}`,
  `golang.org/x/text v0.3.0/go.mod ${H}`,
  `example.com/pseudo v0.0.0-20210101000000-abcdef123456 ${H}`,
  '',
].join('\n');

describe('parseGoSum', () => {
  it('reads both line kinds and strips /go.mod from the version', () => {
    expect(parseGoSum(GO_SUM)).toEqual([
      { kind: 'zip', module: 'github.com/Azure/go-autorest', version: 'v14.2.0+incompatible' },
      { kind: 'mod', module: 'github.com/Azure/go-autorest', version: 'v14.2.0+incompatible' },
      { kind: 'zip', module: 'golang.org/x/text', version: 'v0.14.0' },
      { kind: 'mod', module: 'golang.org/x/text', version: 'v0.14.0' },
      { kind: 'mod', module: 'golang.org/x/text', version: 'v0.3.0' },
      { kind: 'zip', module: 'example.com/pseudo', version: 'v0.0.0-20210101000000-abcdef123456' },
    ]);
  });

  it('accepts CRLF line endings', () => {
    expect(parseGoSum(`golang.org/x/text v0.14.0 ${H}\r\n`)).toHaveLength(1);
  });

  it('skips blank and malformed lines without throwing', () => {
    const content = [
      '',
      '   ',
      'golang.org/x/text',
      `golang.org/x/text v0.14.0`,
      `golang.org/x/text v0.14.0 sha256:abc=`,
      `golang.org/x/text v0.14.0 h1:`,
      `golang.org/x/text v0.14 ${H}`,
      `golang.org/x/text v0.14.0 ${H} extra`,
      `golang.org/x/text  v0.14.0 ${H}`,
      `golang.org/x/text v0.14.0\t${H}`,
      `golang.org/x/text v1.0.0 ${H}`,
    ].join('\n');
    expect(parseGoSum(content)).toEqual([
      { kind: 'zip', module: 'golang.org/x/text', version: 'v1.0.0' },
    ]);
  });

  it('contributes nothing for injection-shaped modules and versions', () => {
    const bad = [
      `../evil v1.0.0 ${H}`,
      `a/../b v1.0.0 ${H}`,
      `a//b v1.0.0 ${H}`,
      `/a v1.0.0 ${H}`,
      `a/ v1.0.0 ${H}`,
      `a;b v1.0.0 ${H}`,
      `a/-b v1.0.0 ${H}`,
      `a%2fb v1.0.0 ${H}`,
      `a@b v1.0.0 ${H}`,
      `a/b v1.0.0;id ${H}`,
      `a/b v1.0.0/../x/go.mod ${H}`,
      `a/b v1.0.0/go.mod/go.mod ${H}`,
      `a/b v01.0.0 ${H}`,
      `a/b/${'x'.repeat(400)} v1.0.0 ${H}`,
      `a/b v1.0.0-${'x'.repeat(200)} ${H}`,
      // A newline inside what looks like one field splits it into two lines, neither valid.
      `a/b\n v1.0.0 ${H}`,
      `a/b v1.0.0\n${H}`,
    ].join('\n');
    expect(parseGoSum(bad)).toEqual([]);
  });

  it('stops at 200,000 lines', () => {
    const line = `a/b v1.0.0 ${H}\n`;
    const entries = parseGoSum(line.repeat(200_001));
    expect(entries).toHaveLength(200_000);
  });

  it('is empty for empty content', () => {
    expect(parseGoSum('')).toEqual([]);
    expect(GO_SUM_NAME).toBe('go.sum');
  });
});

describe('isValidGoModulePath', () => {
  it('accepts real module paths, uppercase included', () => {
    for (const p of [
      'golang.org/x/text',
      'github.com/Azure/go-autorest',
      'gopkg.in/yaml.v3',
      'a',
    ]) {
      expect(isValidGoModulePath(p)).toBe(true);
    }
  });

  it('rejects anything that is not a plain path', () => {
    for (const p of ['', '/a', 'a/', 'a//b', '.', '..', 'a/./b', 'a/../b', 'a/-b', 'a b', 'a\nb']) {
      expect(isValidGoModulePath(p)).toBe(false);
    }
    expect(isValidGoModulePath('a'.repeat(301))).toBe(false);
    expect(isValidGoModulePath('a'.repeat(300))).toBe(true);
  });
});

describe('isValidGoVersion', () => {
  it('accepts releases, pre-releases, pseudo-versions and +incompatible', () => {
    for (const v of [
      'v0.0.0',
      'v1.2.3',
      'v1.2.3-rc.1',
      'v0.0.0-20210101000000-abcdef123456',
      'v2.0.0+incompatible',
    ]) {
      expect(isValidGoVersion(v)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const v of ['1.2.3', 'v1.2', 'v01.2.3', 'v1.2.3/go.mod', 'v1.2.3 ', 'v1.2.3;', 'latest']) {
      expect(isValidGoVersion(v)).toBe(false);
    }
    expect(isValidGoVersion(`v1.0.0-${'a'.repeat(128)}`)).toBe(false);
  });
});

describe('buildGoAllowlist', () => {
  it('keys by module, with a /go.mod suffix only for go.mod-only entries', () => {
    const allow = buildGoAllowlist(parseGoSum(GO_SUM));
    expect([...allow.keys()].sort()).toEqual([
      'example.com/pseudo',
      'github.com/Azure/go-autorest',
      'golang.org/x/text',
    ]);
    expect([...(allow.get('golang.org/x/text') ?? [])].sort()).toEqual([
      'v0.14.0',
      'v0.14.0/go.mod',
      'v0.3.0/go.mod',
    ]);
    expect(allow.get('example.com/pseudo')?.has('v0.0.0-20210101000000-abcdef123456')).toBe(true);
  });

  it('is empty for no entries', () => {
    expect(buildGoAllowlist([]).size).toBe(0);
  });
});
