import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { describeApiError, detailLines, shortSha, sourceLabel } from './sourceDisplay';

describe('detailLines', () => {
  it('reads conflicts, errors, warnings and bare names, and shows hidden characters in each', () => {
    expect(
      detailLines([
        { existingId: 'x', name: 'alpha', scope: 'GLOBAL' },
        { errors: ['no frontmatter', 'bad name'], name: 'beta' },
        { name: 'gamma', warnings: ['injection:x'] },
        'del‮ta',
        { name: 'ep​silon', scope: 'TEAM' },
      ])
    ).toEqual([
      'alpha: already exists (GLOBAL scope)',
      'beta: no frontmatter; bad name',
      'gamma: injection:x',
      'del⟨U+202E⟩ta',
      'ep⟨U+200B⟩silon: already exists (TEAM scope)',
    ]);
  });

  it('ignores anything that is not a list of such rows', () => {
    expect(detailLines(undefined)).toEqual([]);
    expect(detailLines({ name: 'x' })).toEqual([]);
    expect(detailLines([null, 3, {}])).toEqual([]);
  });
});

describe('describeApiError', () => {
  it('carries the status, code and the lines of an ApiError, and degrades for anything else', () => {
    const err = new ApiError('nope', 409, 'SKILL_IMPORT_NAME_CONFLICT', [
      { name: 'a', scope: 'GLOBAL' },
    ]);
    expect(describeApiError(err, 'x')).toMatchObject({
      code: 'SKILL_IMPORT_NAME_CONFLICT',
      lines: ['a: already exists (GLOBAL scope)'],
      message: 'nope',
      status: 409,
    });
    expect(describeApiError('boom', 'fallback')).toMatchObject({ message: 'fallback', status: 0 });
  });
});

describe('labels', () => {
  it('shortens a sha to seven characters and makes the location visible', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456');
    expect(shortSha(null)).toBe('—');
    expect(sourceLabel({ host: 'github.com', owner: 'o‮', path: 'skills', repo: 'r' })).toBe(
      'github.com/o⟨U+202E⟩/r/skills'
    );
  });
});
