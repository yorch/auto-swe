import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { describeProfileError, hasHookChanges } from './profileDisplay';

describe('hasHookChanges', () => {
  it('is false for nothing, true for any bucket', () => {
    expect(hasHookChanges(undefined)).toBe(false);
    expect(hasHookChanges({ added: [], changed: [], removed: [] })).toBe(false);
    expect(
      hasHookChanges({ added: [], changed: [], removed: [{ commands: ['a'], path: 'p' }] })
    ).toBe(true);
  });
});

describe('describeProfileError', () => {
  it('reads the hook diff off a HOOK_CHANGES_UNACKNOWLEDGED refusal', () => {
    const err = new ApiError(
      'Hook changes must be acknowledged',
      409,
      'HOOK_CHANGES_UNACKNOWLEDGED',
      {
        hookChanges: {
          added: [{ commands: ['run'], path: 'hooks/hooks.json' }],
          changed: [{ addedCommands: ['b'], path: 'x.json', removedCommands: ['a'] }],
          removed: [],
        },
      }
    );
    const d = describeProfileError(err, 'f');
    expect(d.hooksUnacknowledged).toBe(true);
    expect(d.hookChanges?.added[0]?.commands).toEqual(['run']);
    expect(d.hookChanges?.changed[0]?.removedCommands).toEqual(['a']);
  });

  it('flags every moved-preview code as stale', () => {
    for (const code of ['PREVIEW_STALE', 'SHA_MOVED', 'MARKETPLACE_SHA_MOVED']) {
      expect(describeProfileError(new ApiError('m', 409, code), 'f').stale).toBe(true);
    }
    expect(describeProfileError(new ApiError('m', 409, 'OTHER'), 'f').stale).toBe(false);
  });

  it('tolerates a details value of any shape', () => {
    const d = describeProfileError(new ApiError('m', 409, 'X', 'text'), 'f');
    expect(d.hookChanges).toBeNull();
  });
});
