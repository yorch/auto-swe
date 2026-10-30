import { describe, expect, it } from 'vitest';
import { registriesFor, resolvePackageRegistries } from './packageRegistry.js';

const row = (
  id: string,
  teamId: string | null,
  npmScopes: string[] = [],
  isActive = true,
  ecosystem?: string
) => ({
  ecosystem,
  id,
  isActive,
  npmScopes,
  teamId,
});

describe('resolvePackageRegistries', () => {
  it('picks team rows over global rows on the same key, and only the team’s rows', () => {
    const rows = [
      row('g1', null),
      row('t1', 'team-a'),
      row('t2', 'team-b'),
      row('g-scope', null, ['@acme']),
    ];
    // t1 (a team default) shadows g1's default key; the scoped global survives.
    expect(resolvePackageRegistries(rows, 'team-a').map((r) => r.registry.id)).toEqual([
      't1',
      'g-scope',
    ]);
    // team-b's own default shadows g1 the same way; the scoped global survives.
    expect(resolvePackageRegistries(rows, 'team-b').map((r) => r.registry.id)).toEqual([
      't2',
      'g-scope',
    ]);
  });

  it('lets a team row shadow a global row on the same key', () => {
    const rows = [row('g-def', null), row('t-def', 'team-a'), row('g-acme', null, ['@acme'])];
    const rows2 = [...rows, row('t-acme', 'team-a', ['@acme'])];
    expect(resolvePackageRegistries(rows2, 'team-a').map((r) => r.registry.id)).toEqual([
      't-def',
      't-acme',
    ]);
    // Without the team scope rows the globals still apply.
    expect(resolvePackageRegistries(rows, 'team-b').map((r) => r.registry.id)).toEqual([
      'g-def',
      'g-acme',
    ]);
  });

  it('ignores inactive rows and other teams', () => {
    const rows = [row('off', null, [], false), row('other', 'team-b')];
    expect(resolvePackageRegistries(rows, 'team-a')).toEqual([]);
    expect(resolvePackageRegistries(rows, null)).toEqual([]);
  });
});

describe('registriesFor', () => {
  const rows = [
    row('npm-g', null),
    row('npm-implicit', null, ['@acme'], true, undefined),
    row('npm-explicit', null, [], true, 'npm'),
    row('go-g', null, [], true, 'go'),
    row('go-t', 'team-a', [], true, 'go'),
    row('go-other', 'team-b', [], true, 'go'),
  ];

  it('treats a row with no ecosystem as npm', () => {
    expect(registriesFor(rows, 'npm').map((r) => r.id)).toEqual([
      'npm-g',
      'npm-implicit',
      'npm-explicit',
    ]);
    expect(registriesFor(rows, 'go').map((r) => r.id)).toEqual(['go-g', 'go-t', 'go-other']);
  });

  it('resolves go rows as one default, a team row beating a global one', () => {
    const forTeam = resolvePackageRegistries(registriesFor(rows, 'go'), 'team-a');
    expect(forTeam.map((r) => [r.registry.id, r.isDefault, r.scopes])).toEqual([
      ['go-t', true, []],
    ]);
    const noTeamRow = resolvePackageRegistries(registriesFor(rows, 'go'), 'team-c');
    expect(noTeamRow.map((r) => [r.registry.id, r.isDefault])).toEqual([['go-g', true]]);
  });

  it('makes a go row with no scopes the default, whatever its npm neighbours claim', () => {
    const only = [row('go-1', null, [], true, 'go')];
    const [resolved] = resolvePackageRegistries(registriesFor(only, 'go'), null);
    expect(resolved?.isDefault).toBe(true);
  });

  it('never lets go rows affect npm resolution once filtered', () => {
    const mixed = [row('npm-g', null), row('go-t', 'team-a', [], true, 'go')];
    // Unfiltered, the go team row would shadow the npm default.
    expect(resolvePackageRegistries(mixed, 'team-a').map((r) => r.registry.id)).toEqual(['go-t']);
    expect(
      resolvePackageRegistries(registriesFor(mixed, 'npm'), 'team-a').map((r) => r.registry.id)
    ).toEqual(['npm-g']);
  });
});
