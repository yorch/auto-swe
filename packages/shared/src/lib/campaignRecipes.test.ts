import { describe, expect, it } from 'vitest';
import { BUILTIN_SHELL_IMAGES } from '../workflow/shellImageAllowlist.js';
import {
  CAMPAIGN_RECIPE_REFS,
  CAMPAIGN_RECIPES,
  isCampaignRecipeRef,
  parseRecipeParams,
} from './campaignRecipes.js';

const HOSTILE = [
  '$(touch /tmp/x)',
  '`id`',
  'a;b',
  'a&&b',
  'a|b',
  'a b',
  'a\nb',
  'a\r\nb',
  'a\tb',
  "a'b",
  'a"b',
  'a\\b',
  'a>b',
  'a<b',
  ['$', '{IFS}'].join(''),
  '--registry=https://evil.example',
  '-rf',
  '../x',
  'ünï/cödé',
  'a\u0000b',
  '',
  ' ',
];

describe('recipe catalogue', () => {
  it('names two recipes, each on an allowlisted image', () => {
    expect(CAMPAIGN_RECIPE_REFS.sort()).toEqual(['go-module@1', 'npm-dependency@1']);
    for (const recipe of Object.values(CAMPAIGN_RECIPES)) {
      expect(BUILTIN_SHELL_IMAGES).toContain(recipe.image);
    }
  });

  it('recognises only catalogue refs, including inherited property names', () => {
    expect(isCampaignRecipeRef('npm-dependency@1')).toBe(true);
    expect(isCampaignRecipeRef('npm-dependency@2')).toBe(false);
    expect(isCampaignRecipeRef('toString')).toBe(false);
    expect(isCampaignRecipeRef('__proto__')).toBe(false);
    expect(isCampaignRecipeRef(undefined)).toBe(false);
  });
});

describe('npm-dependency@1 parameters', () => {
  const ok = (packageName: string, targetVersion: string) =>
    parseRecipeParams('npm-dependency@1', { packageName, targetVersion });

  it.each([
    ['lodash', '4.17.21'],
    ['@scope/pkg', '1.0.0'],
    ['@types/node', '26.0.1'],
    ['left-pad', '1.3.0-rc.1'],
    ['a.b_c~d', '10.20.30-beta.2'],
  ])('accepts %s@%s', (name, version) => {
    const r = ok(name, version);
    expect(r).toEqual({
      ok: true,
      params: { packageName: name, targetVersion: version },
      ref: 'npm-dependency@1',
    });
  });

  it.each(HOSTILE)('rejects a hostile package name %j', (name) => {
    expect(ok(name, '1.0.0').ok).toBe(false);
  });

  it.each(HOSTILE)('rejects a hostile version %j', (version) => {
    expect(ok('lodash', version).ok).toBe(false);
  });

  it.each([
    'github:evil/repo',
    'git+https://evil.example/x.git',
    'file:../x',
    'npm:other@1',
    'https://evil.example/x.tgz',
    '@scope',
    '@/x',
    '@scope/',
    'a/b',
    '-x',
    '@-x/y',
    'UPPER:case',
  ])('rejects the non-registry specifier %j', (name) => {
    expect(ok(name, '1.0.0').ok).toBe(false);
  });

  it.each(['^1.0.0', '~1.0.0', '>=1', '1', '1.0', 'latest', '1.x', '*', '1.0.0 - 2.0.0', 'v1.0.0'])(
    'rejects the range or tag %j',
    (version) => {
      expect(ok('lodash', version).ok).toBe(false);
    }
  );

  it('rejects an over-long name and unknown or missing keys', () => {
    expect(ok('a'.repeat(215), '1.0.0').ok).toBe(false);
    expect(
      parseRecipeParams('npm-dependency@1', {
        extra: 'x',
        packageName: 'lodash',
        targetVersion: '1.0.0',
      }).ok
    ).toBe(false);
    expect(parseRecipeParams('npm-dependency@1', { packageName: 'lodash' }).ok).toBe(false);
    expect(parseRecipeParams('npm-dependency@1', null).ok).toBe(false);
    expect(parseRecipeParams('npm-dependency@1', 'lodash@1.0.0').ok).toBe(false);
  });

  it('does not accept a trailing newline after an otherwise valid value', () => {
    expect(ok('lodash\n', '1.0.0').ok).toBe(false);
    expect(ok('lodash', '1.0.0\n').ok).toBe(false);
  });
});

describe('go-module@1 parameters', () => {
  const ok = (packageName: string, targetVersion: string) =>
    parseRecipeParams('go-module@1', { packageName, targetVersion });

  it.each([
    ['github.com/stretchr/testify', 'v1.9.0'],
    ['golang.org/x/net', 'v0.30.0'],
    ['gopkg.in/yaml.v3', 'v3.0.1'],
    ['github.com/foo/bar/v2', 'v2.1.0-rc.1'],
    ['example.com/x', 'v2.0.0+incompatible'],
  ])('accepts %s@%s', (mod, version) => {
    expect(ok(mod, version).ok).toBe(true);
  });

  it.each(HOSTILE)('rejects a hostile module %j', (mod) => {
    expect(ok(mod, 'v1.0.0').ok).toBe(false);
  });

  it.each(HOSTILE)('rejects a hostile version %j', (version) => {
    expect(ok('github.com/a/b', version).ok).toBe(false);
  });

  it.each([
    '-x/y',
    '-flag/path',
    'github.com',
    'github.com/../x',
    'github.com/./x',
    'github.com//x',
    'github.com/x/',
    'GitHub.com/x',
    'github.com/-x',
  ])('rejects the module path %j', (mod) => {
    expect(ok(mod, 'v1.0.0').ok).toBe(false);
  });

  it.each(['1.0.0', 'latest', 'v1', 'v1.0', 'master', 'v1.0.0 ', 'v1.x.0'])(
    'rejects the version %j (a missing v, a ref or a partial)',
    (version) => {
      expect(ok('github.com/a/b', version).ok).toBe(false);
    }
  );
});

describe('parseRecipeParams', () => {
  it('rejects an unknown recipe without echoing a hostile ref', () => {
    const r = parseRecipeParams('$(id)@1', { packageName: 'a', targetVersion: '1.0.0' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain('$(id)');
      expect(r.error).toContain('npm-dependency@1');
    }
  });

  it('does not echo a rejected value', () => {
    const r = parseRecipeParams('npm-dependency@1', {
      packageName: '$(curl evil.example)',
      targetVersion: '1.0.0',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain('curl');
    }
  });

  it('bounds the error text', () => {
    const r = parseRecipeParams('npm-dependency@1', {
      [`k${'x'.repeat(5000)}`]: 1,
      packageName: 'a',
      targetVersion: '1.0.0',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.length).toBeLessThanOrEqual(300);
    }
  });
});
