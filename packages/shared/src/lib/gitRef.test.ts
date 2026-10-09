import { describe, expect, it } from 'vitest';
import {
  BaseBranchSchema,
  baseBranchFromPayload,
  isPlatformWorkBranch,
  isSafeGitBranchName,
  MAX_BRANCH_NAME_LENGTH,
} from './gitRef.js';

describe('isSafeGitBranchName', () => {
  it.each(['main', 'release/1.4', 'release/v2.0.x', 'feature/JIRA-12_fix', 'hotfix/ünïcode', 'a'])(
    'accepts %s',
    (name) => {
      expect(isSafeGitBranchName(name)).toBe(true);
    }
  );

  it.each([
    ['empty', ''],
    ['a leading dash (an option to git)', '-upload-pack=x'],
    ['a space', 'release 1'],
    ['a shell metacharacter git also refuses', 'a:b'],
    ['a tilde', 'a~1'],
    ['a caret', 'a^'],
    ['a question mark', 'a?'],
    ['a glob star', 'a*'],
    ['an open bracket', 'a[b'],
    ['a backslash', 'a\\b'],
    ['a double dot', 'a..b'],
    ['a reflog expression', 'a@{1}'],
    ['the bare @', '@'],
    ['HEAD', 'HEAD'],
    ['a trailing dot', 'release.'],
    ['a leading slash', '/main'],
    ['a trailing slash', 'main/'],
    ['a doubled slash', 'release//1'],
    ['a dot-led component', 'release/.hidden'],
    ['a .lock component', 'release/x.lock'],
    ['a newline', 'main\nrm -rf /'],
    ['a NUL', 'main\u0000'],
    ['DEL', 'main\u007f'],
    ['too long', 'a'.repeat(MAX_BRANCH_NAME_LENGTH + 1)],
  ])('refuses %s', (_label, name) => {
    expect(isSafeGitBranchName(name)).toBe(false);
  });

  it('agrees with the zod schema', () => {
    expect(BaseBranchSchema.safeParse('release/1.4').success).toBe(true);
    expect(BaseBranchSchema.safeParse('-x').success).toBe(false);
  });
});

describe('isPlatformWorkBranch', () => {
  it('matches the prefix itself and anything under it', () => {
    expect(isPlatformWorkBranch('auto', 'auto')).toBe(true);
    expect(isPlatformWorkBranch('auto/JIRA-1', 'auto')).toBe(true);
    expect(isPlatformWorkBranch('bots/auto/x', 'bots/auto')).toBe(true);
  });

  it('does not match a branch that merely starts with the same letters', () => {
    expect(isPlatformWorkBranch('automation/x', 'auto')).toBe(false);
    expect(isPlatformWorkBranch('main', 'auto')).toBe(false);
  });
});

describe('baseBranchFromPayload', () => {
  it('is undefined when the payload names no base', () => {
    expect(baseBranchFromPayload(undefined)).toEqual({ baseBranch: undefined, ok: true });
    expect(baseBranchFromPayload({})).toEqual({ baseBranch: undefined, ok: true });
    expect(baseBranchFromPayload({ baseBranch: '' })).toEqual({ baseBranch: undefined, ok: true });
    expect(baseBranchFromPayload([])).toEqual({ baseBranch: undefined, ok: true });
  });

  it('returns a valid base', () => {
    expect(baseBranchFromPayload({ baseBranch: 'release/1.4' })).toEqual({
      baseBranch: 'release/1.4',
      ok: true,
    });
  });

  it('refuses an invalid one instead of dropping it', () => {
    expect(baseBranchFromPayload({ baseBranch: '-x' }).ok).toBe(false);
    expect(baseBranchFromPayload({ baseBranch: 42 }).ok).toBe(false);
  });
});
