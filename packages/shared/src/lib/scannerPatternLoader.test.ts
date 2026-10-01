import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../db.js');
  vi.resetModules();
});

describe('scanner pattern loading', () => {
  it('importing the skill scanner does not touch the database (no DATABASE_URL needed)', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    vi.resetModules();
    try {
      // db.ts throws at module load without DATABASE_URL; a static import of
      // it from skillScanner used to make this import fail.
      await expect(import('./skillScanner.js')).resolves.toHaveProperty('scanSkillContent');
    } finally {
      if (saved !== undefined) {
        process.env.DATABASE_URL = saved;
      }
    }
  });

  it('one loader serves several types and tags each entry with its type', async () => {
    const findMany = vi.fn(async (_args: unknown) => [
      { flags: '', label: 'a', pattern: 'x', type: 'INJECTION' },
      { flags: 'i', label: 'b', pattern: 'y', type: 'EXFILTRATION' },
      { flags: '', label: 'bad', pattern: '(', type: 'INJECTION' },
    ]);
    vi.doMock('../db.js', () => ({ prisma: { scannerPattern: { findMany } } }));
    const { makePatternLoader } = await import('./scannerPatternLoader.js');
    const { load } = makePatternLoader(['INJECTION', 'EXFILTRATION'], 'test');
    await expect(load()).resolves.toEqual([
      { flags: '', label: 'a', source: 'x', type: 'INJECTION' },
      { flags: 'i', label: 'b', source: 'y', type: 'EXFILTRATION' },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { label: 'asc' },
      where: { isActive: true, type: { in: ['INJECTION', 'EXFILTRATION'] } },
    });
  });

  it('is the same list the bundle schema validates against', async () => {
    const { SCANNER_PATTERN_TYPES: fromBundle } = await import('../bundle/index.js');
    const { SCANNER_PATTERN_TYPES: fromLoader } = await import('./scannerCache.js');
    expect(fromBundle).toBe(fromLoader);
  });
});
