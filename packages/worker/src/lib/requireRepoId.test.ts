import { describe, expect, it } from 'vitest';
import { requireRepoId } from './requireRepoId.js';

describe('requireRepoId', () => {
  it('returns the id when the run is connection-scoped', () => {
    expect(requireRepoId({ repoId: 'conn-1' }, 'executeImplementation')).toBe('conn-1');
  });

  it('rejects null with an error naming the step', () => {
    expect(() => requireRepoId({ repoId: null }, 'runLint')).toThrow(/Step 'runLint'/);
  });

  it('rejects the empty string the generic triggers used to send', () => {
    // This is the whole point: `''` used to reach Prisma and fail with "No
    // Connection found" for an id nobody supplied.
    expect(() => requireRepoId({ repoId: '' }, 'createOrUpdatePullRequest')).toThrow(
      /not scoped to a connection/
    );
  });

  it('tells the caller what to do about it', () => {
    expect(() => requireRepoId({ repoId: null }, 'shell')).toThrow(/connectionId/);
  });

  it('fails non-retryably — a missing connection will not appear on retry', () => {
    const err = (() => {
      try {
        requireRepoId({ repoId: null }, 'shell');
      } catch (e) {
        return e as { nonRetryable?: boolean; type?: string };
      }
    })();
    expect(err?.nonRetryable).toBe(true);
    expect(err?.type).toBe('NO_CONNECTION');
  });
});
