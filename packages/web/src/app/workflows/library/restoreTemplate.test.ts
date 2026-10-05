import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { restoreTemplate } from './restoreTemplate';

describe('restoreTemplate', () => {
  it('returns a template with no active version to draft', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    await restoreTemplate(null, set);
    expect(set.mock.calls).toEqual([['DRAFT']]);
  });

  it('activates a template whose active version can serve runs', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    await restoreTemplate(3, set);
    expect(set.mock.calls).toEqual([['ACTIVE']]);
  });

  it('falls back to draft when the active version still needs review', async () => {
    const set = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('review first', 409, 'REVIEW_REQUIRED'))
      .mockResolvedValueOnce(undefined);
    await restoreTemplate(3, set);
    expect(set.mock.calls).toEqual([['ACTIVE'], ['DRAFT']]);
  });

  it('falls back to draft when the active version has errors', async () => {
    const set = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('has errors', 409, 'SPEC_HAS_ERRORS'))
      .mockResolvedValueOnce(undefined);
    await restoreTemplate(3, set);
    expect(set.mock.calls).toEqual([['ACTIVE'], ['DRAFT']]);
  });

  it('does not swallow any other refusal', async () => {
    const err = new ApiError('forbidden', 403, 'FORBIDDEN');
    const set = vi.fn().mockRejectedValue(err);
    await expect(restoreTemplate(3, set)).rejects.toBe(err);
    expect(set).toHaveBeenCalledTimes(1);
  });
});
