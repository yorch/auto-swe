import { describe, expect, it } from 'vitest';
import { baseProfiles, mergeProfiles, splitArgs } from './compose.mjs';

describe('splitArgs', () => {
  it('takes leading --add-profile flags in both spellings and leaves the rest for compose', () => {
    expect(splitArgs(['--add-profile', 'a', '--add-profile=b', '-f', 'x.yml', 'up', '-d'])).toEqual(
      { add: ['a', 'b'], rest: ['-f', 'x.yml', 'up', '-d'] }
    );
  });

  it('stops at the first compose argument', () => {
    expect(splitArgs(['ps', '--add-profile', 'a'])).toEqual({
      add: [],
      rest: ['ps', '--add-profile', 'a'],
    });
  });

  it('refuses a flag with no name', () => {
    expect(() => splitArgs(['--add-profile'])).toThrow(/needs a profile name/);
  });
});

describe('baseProfiles', () => {
  it('reads COMPOSE_PROFILES from .env when the shell has none', () => {
    expect(baseProfiles({}, 'FOO=1\nCOMPOSE_PROFILES=objectstore\n')).toBe('objectstore');
  });

  it('lets the shell win over .env, even when the shell value is empty', () => {
    expect(baseProfiles({ COMPOSE_PROFILES: 'x' }, 'COMPOSE_PROFILES=objectstore\n')).toBe('x');
    expect(baseProfiles({ COMPOSE_PROFILES: '' }, 'COMPOSE_PROFILES=objectstore\n')).toBe('');
  });

  it('is empty with no .env and no shell value', () => {
    expect(baseProfiles({}, undefined)).toBe('');
    expect(baseProfiles({}, 'FOO=1\n')).toBe('');
  });
});

describe('mergeProfiles', () => {
  it('adds to the configured profiles instead of replacing them', () => {
    expect(mergeProfiles('objectstore', ['temporal-ui'])).toBe('objectstore,temporal-ui');
  });

  it('keeps a hosted-store setup (empty profiles) free of the bundled store', () => {
    expect(mergeProfiles('', ['temporal-ui'])).toBe('temporal-ui');
  });

  it('drops duplicates and blanks', () => {
    expect(mergeProfiles(' objectstore, ,temporal-ui', ['temporal-ui'])).toBe(
      'objectstore,temporal-ui'
    );
  });
});
