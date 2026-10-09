import { describe, expect, it } from 'vitest';
import {
  requestedBaseBranch,
  resolveRequestBaseBranch,
  resolveRunBaseBranch,
} from './runBaseBranch.js';

const repo = { defaultBranch: 'main' };

describe('resolveRunBaseBranch', () => {
  it('falls back to the default branch when the run names none', async () => {
    await expect(resolveRunBaseBranch(undefined, repo)).resolves.toBe('main');
    await expect(resolveRunBaseBranch(null, repo)).resolves.toBe('main');
    await expect(resolveRunBaseBranch('', repo)).resolves.toBe('main');
  });

  it('returns the requested base', async () => {
    await expect(resolveRunBaseBranch('release/1.4', repo)).resolves.toBe('release/1.4');
  });

  it('refuses an unsafe name non-retryably', async () => {
    await expect(resolveRunBaseBranch('-upload-pack=x', repo)).rejects.toMatchObject({
      nonRetryable: true,
      type: 'BASE_BRANCH_REFUSED',
    });
  });
});

describe('requestedBaseBranch', () => {
  it('reads the base from the payload, the one place every launch path keeps', () => {
    expect(requestedBaseBranch({ payload: { baseBranch: 'release/1.4' } })).toBe('release/1.4');
    expect(requestedBaseBranch({ payload: { description: 'x' } })).toBeUndefined();
    expect(requestedBaseBranch({ payload: undefined })).toBeUndefined();
  });

  it('refuses a malformed base instead of silently using the default branch', () => {
    expect(() => requestedBaseBranch({ payload: { baseBranch: 'a..b' } })).toThrow(
      /not a valid branch name/
    );
  });

  it('resolves through to the default branch', async () => {
    await expect(resolveRequestBaseBranch({ payload: {} }, repo)).resolves.toBe('main');
    await expect(
      resolveRequestBaseBranch({ payload: { baseBranch: 'release/2' } }, repo)
    ).resolves.toBe('release/2');
  });
});
