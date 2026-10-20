import { describe, expect, it } from 'vitest';
import { resolvePackageRegistries } from './packageRegistry.js';

const row = (id: string, teamId: string | null, npmScopes: string[] = [], isActive = true) => ({
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
