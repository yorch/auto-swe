import { describe, expect, it } from 'vitest';
import {
  isRepositoryOwnerKey,
  ownerKeyHost,
  parseOwnerKey,
  repositoryOwnerKey,
  sigilOwnerKey,
  teamOwnerKey,
} from './ownerKey.js';

const TEAM = '11111111-0000-4000-8000-000000000001';

describe('owner keys', () => {
  it('spells a repository exactly as the ledger always has: lowercased, no prefix', () => {
    expect(repositoryOwnerKey('GitHub.com', 'Acme/API')).toBe('github.com/acme/api');
    expect(repositoryOwnerKey('ghe.example.com:8443', 'acme/api')).toBe(
      'ghe.example.com:8443/acme/api'
    );
  });

  it('spells every other owner with the sigil', () => {
    expect(teamOwnerKey(TEAM)).toBe(`@team/${TEAM}`);
    expect(sigilOwnerKey('endpoint', 'e1')).toBe('@endpoint/e1');
    expect(() => sigilOwnerKey('repository', 'x')).toThrow();
    expect(() => sigilOwnerKey('Team', 'x')).toThrow();
    expect(() => sigilOwnerKey('team', '')).toThrow();
  });

  it('parses both shapes back', () => {
    expect(parseOwnerKey('github.com/acme/api')).toEqual({
      fullName: 'acme/api',
      host: 'github.com',
      kind: 'repository',
    });
    expect(parseOwnerKey(`@team/${TEAM}`)).toEqual({ id: TEAM, kind: 'team' });
    expect(parseOwnerKey('@owner/abc')).toEqual({ id: 'abc', kind: 'owner' });
  });

  it('reads nothing from a key that is neither', () => {
    for (const key of [
      '',
      '/',
      'github.com',
      'github.com/',
      '/acme/api',
      '@/x',
      '@team/',
      '@T/x',
    ]) {
      expect(parseOwnerKey(key)).toBeNull();
      expect(isRepositoryOwnerKey(key)).toBe(false);
    }
  });

  it('derives a host only from a repository key', () => {
    expect(isRepositoryOwnerKey('github.com/acme/api')).toBe(true);
    expect(ownerKeyHost('github.com/acme/api')).toBe('github.com');
    expect(isRepositoryOwnerKey(`@team/${TEAM}`)).toBe(false);
    expect(ownerKeyHost(`@team/${TEAM}`)).toBeNull();
    expect(ownerKeyHost('@endpoint/github.com')).toBeNull();
  });
});
