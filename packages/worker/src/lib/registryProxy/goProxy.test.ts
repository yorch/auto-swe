import { buildGoAllowlist, parseGoSum } from '@auto-swe/shared/lib/goModuleAllowlist';
import { describe, expect, it } from 'vitest';
import {
  escapeGoPath,
  goAllowed,
  goListBody,
  goUpstreamPath,
  parseGoProxyPath,
  unescapeGoPath,
} from './goProxy.js';

const H = 'h1:Zk9oB1xq3YxQb0m8r4K3tq8o1P0lq4vV2m5z7W9y8X0=';
const allow = buildGoAllowlist(
  parseGoSum(
    [
      `golang.org/x/text v0.14.0 ${H}`,
      `golang.org/x/text v0.14.0/go.mod ${H}`,
      `golang.org/x/text v0.3.0/go.mod ${H}`,
      `github.com/Azure/go-autorest v14.2.0+incompatible ${H}`,
    ].join('\n')
  )
);

describe('escapeGoPath / unescapeGoPath', () => {
  it('round-trips', () => {
    for (const s of ['github.com/Azure/go-autorest', 'a/b', 'AbC/dEf', 'v1.0.0-RC1', '']) {
      expect(unescapeGoPath(escapeGoPath(s))).toBe(s);
    }
    expect(escapeGoPath('github.com/Azure/go-autorest')).toBe('github.com/!azure/go-autorest');
  });

  it('refuses raw uppercase and any other bang', () => {
    for (const s of ['github.com/Azure', '!', 'a!', '!!a', '!A', '!1', 'a!/b', '!-']) {
      expect(unescapeGoPath(s)).toBeNull();
    }
  });
});

describe('parseGoProxyPath', () => {
  it('parses every shape', () => {
    expect(parseGoProxyPath('/golang.org/x/text/@v/list')).toEqual({
      kind: 'list',
      module: 'golang.org/x/text',
    });
    expect(parseGoProxyPath('/golang.org/x/text/@latest')).toEqual({
      kind: 'latest',
      module: 'golang.org/x/text',
    });
    for (const kind of ['info', 'mod', 'zip'] as const) {
      expect(parseGoProxyPath(`/golang.org/x/text/@v/v0.14.0.${kind}`)).toEqual({
        kind,
        module: 'golang.org/x/text',
        version: 'v0.14.0',
      });
    }
  });

  it('decodes bang escapes in module and version', () => {
    expect(parseGoProxyPath('/github.com/!azure/go-autorest/@v/v14.2.0+incompatible.zip')).toEqual({
      kind: 'zip',
      module: 'github.com/Azure/go-autorest',
      version: 'v14.2.0+incompatible',
    });
    expect(parseGoProxyPath('/a/b/@v/v1.0.0-!r!c1.info')?.version).toBe('v1.0.0-RC1');
  });

  it('parses a pseudo-version', () => {
    expect(
      parseGoProxyPath('/example.com/m/@v/v0.0.0-20210101000000-abcdef123456.mod')?.version
    ).toBe('v0.0.0-20210101000000-abcdef123456');
  });

  it('refuses unsafe or unrecognised paths', () => {
    const bad = [
      '',
      'golang.org/x/text/@v/list',
      '/',
      '/@v/list',
      '/@latest',
      '/golang.org/x/text',
      '/golang.org/x/text/@v',
      '/golang.org/x/text/@v/',
      '/golang.org/x/text/@v/v0.14.0',
      '/golang.org/x/text/@v/v0.14.0.tar',
      '/golang.org/x/text/@v/v0.14.0.zip/extra',
      '/golang.org/x/text/@v/list/extra',
      '/golang.org/x/text/@latest/extra',
      '/golang.org/x/text/@v/latest.info',
      '/golang.org/x/text/@v/master.info',
      '/golang.org/x/text/@v/v0.14.0.info?x=1',
      '/golang.org/x/text/@v/v0.14.0.info#x',
      '/golang.org/x/%74ext/@v/list',
      '/golang.org/x/text/@v/v0%2e14.0.info',
      '/golang.org\\x/text/@v/list',
      '/golang.org/x/text\u0000/@v/list',
      '/golang.org/x/te xt/@v/list',
      '/golang.org/x/te\txt/@v/list',
      '/golang.org/x/text\n/@v/list',
      '/golang.org/../text/@v/list',
      '/golang.org/./text/@v/list',
      '/golang.org//text/@v/list',
      '/golang.org/x/text/@v/list/',
      '/golang.org/x/text@v1.0.0/@v/list',
      '/golang.org/@x/text/@v/list',
      '/a/@v/b/@latest',
      '/a/@v/b/@v/list',
      '/github.com/Azure/go-autorest/@v/list',
      '/a/b/@v/V1.0.0.info',
      '/a/b/@v/v1.0.0-RC1.info',
      '/a/b/@v/!v1.0.0.info',
      '/-a/@v/list',
    ];
    for (const p of bad) {
      expect(parseGoProxyPath(p), p).toBeNull();
    }
  });
});

describe('goAllowed', () => {
  const p = (kind: 'info' | 'mod' | 'zip', module: string, version: string) => ({
    kind,
    module,
    version,
  });

  it('allows everything in open mode, list and latest included', () => {
    expect(goAllowed(null, { kind: 'latest', module: 'x/y' })).toBe(true);
    expect(goAllowed(null, { kind: 'list', module: 'x/y' })).toBe(true);
    expect(goAllowed(null, p('zip', 'x/y', 'v1.0.0'))).toBe(true);
  });

  it('serves info and mod for either go.sum line, and a zip only for the plain one', () => {
    expect(goAllowed(allow, p('zip', 'golang.org/x/text', 'v0.14.0'))).toBe(true);
    expect(goAllowed(allow, p('mod', 'golang.org/x/text', 'v0.14.0'))).toBe(true);
    expect(goAllowed(allow, p('info', 'golang.org/x/text', 'v0.14.0'))).toBe(true);
    expect(goAllowed(allow, p('mod', 'golang.org/x/text', 'v0.3.0'))).toBe(true);
    expect(goAllowed(allow, p('info', 'golang.org/x/text', 'v0.3.0'))).toBe(true);
    // Only a go.mod line: the source is not part of the build.
    expect(goAllowed(allow, p('zip', 'golang.org/x/text', 'v0.3.0'))).toBe(false);
  });

  it('refuses unknown modules and versions, and list and latest', () => {
    expect(goAllowed(allow, p('mod', 'golang.org/x/text', 'v0.15.0'))).toBe(false);
    expect(goAllowed(allow, p('mod', 'golang.org/x/net', 'v0.14.0'))).toBe(false);
    expect(goAllowed(allow, p('zip', 'github.com/azure/go-autorest', 'v14.2.0+incompatible'))).toBe(
      false
    );
    expect(goAllowed(allow, { kind: 'list', module: 'golang.org/x/text' })).toBe(false);
    expect(goAllowed(allow, { kind: 'latest', module: 'golang.org/x/text' })).toBe(false);
  });
});

describe('goListBody', () => {
  it('lists the plain versions, sorted, one per line, trailing newline', () => {
    expect(goListBody(allow, 'golang.org/x/text')).toBe('v0.14.0\n');
    const more = buildGoAllowlist(
      parseGoSum(`a/b v1.2.0 ${H}\na/b v1.0.0 ${H}\na/b v1.1.0/go.mod ${H}`)
    );
    expect(goListBody(more, 'a/b')).toBe('v1.0.0\nv1.2.0\n');
  });

  it('is empty for an unknown module or a go.mod-only one', () => {
    expect(goListBody(allow, 'nope/nope')).toBe('');
    expect(goListBody(buildGoAllowlist(parseGoSum(`a/b v1.0.0/go.mod ${H}`)), 'a/b')).toBe('');
  });
});

describe('goUpstreamPath', () => {
  it('re-escapes from the validated values', () => {
    expect(
      goUpstreamPath({ kind: 'zip', module: 'github.com/Azure/go-autorest', version: 'v1.0.0' })
    ).toBe('/github.com/!azure/go-autorest/@v/v1.0.0.zip');
    expect(goUpstreamPath({ kind: 'list', module: 'a/b' })).toBe('/a/b/@v/list');
    expect(goUpstreamPath({ kind: 'latest', module: 'a/b' })).toBe('/a/b/@latest');
    expect(goUpstreamPath({ kind: 'info', module: 'a/b', version: 'v1.0.0-RC1' })).toBe(
      '/a/b/@v/v1.0.0-!r!c1.info'
    );
  });

  it('only ever holds the module-path and version alphabet, whatever parsed', () => {
    const parsed = parseGoProxyPath('/github.com/!azure/go-autorest/@v/v14.2.0+incompatible.mod');
    expect(parsed).not.toBeNull();
    // `+` is the one non-path character a valid version may carry.
    expect(goUpstreamPath(parsed as never)).toMatch(/^\/[A-Za-z0-9._~!+/@-]+$/);
  });
});
