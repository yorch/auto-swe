import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real scanner runs here; only the pattern store is faked, so this covers the
// path a skill save takes when the store cannot be read.
const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { scannerPattern: { findMany } } }));

import { invalidateScannerPatternCache, scanSkillContent } from '@auto-swe/shared/lib/skillScanner';
import { SCAN_INCOMPLETE, scanSkillAdvisory } from './skillScan.js';

beforeEach(() => {
  invalidateScannerPatternCache();
  findMany.mockReset();
});

describe('scanSkillAdvisory', () => {
  it('reports scan-incomplete when the pattern store cannot be read', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await scanSkillAdvisory('a description', 'prompt text')).toEqual([SCAN_INCOMPLETE]);
      // The scanner itself resolves to the incomplete shape (it does not throw):
      // the wrapper's catch is not what answered.
      expect(await scanSkillContent('prompt text')).toMatchObject({
        incomplete: true,
        incompleteReason: 'load-failed',
      });
      // The scanner itself degrades and says so; the wrapper's catch is not what answered.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('pattern load failed'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reports no warnings when every rule ran and nothing matched', async () => {
    findMany.mockResolvedValue([]);
    expect(await scanSkillAdvisory(null, 'prompt text')).toEqual([]);
  });
});
