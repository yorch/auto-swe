import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real scanner and executor run here; only the pattern store is faked.
const { findMany, memoryFindFirst, memoryFindMany } = vi.hoisted(() => ({
  findMany: vi.fn(),
  memoryFindFirst: vi.fn(),
  memoryFindMany: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    memoryItem: { findFirst: memoryFindFirst, findMany: memoryFindMany },
    scannerPattern: { findMany },
  },
}));
vi.mock('./lessonRetrieval.js', () => ({ retrieveSimilarLessons: vi.fn() }));

import { resetRegexExecutor } from '@auto-swe/shared/lib/regexExec';
import { invalidateScannerPatternCache } from '@auto-swe/shared/lib/skillScanner';
import { explainLesson } from './lessonRecall.js';
import {
  assertMemoryContentAllowed,
  MemoryContentRefusedError,
  MemoryScanUnavailableError,
  withoutFlaggedMemory,
} from './memoryGuard.js';

const SLOW = { flags: '', isActive: true, pattern: '(a+)+$' };
const BENIGN_INJECTION = {
  flags: 'i',
  isActive: true,
  label: 'jailbreak',
  pattern: 'jailbreak',
  type: 'INJECTION',
};
// Overruns its budget on this input.
const SLOW_TEXT = `${'a'.repeat(40)}!`;

beforeEach(() => {
  invalidateScannerPatternCache();
  findMany.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  resetRegexExecutor();
  vi.restoreAllMocks();
});

describe('memory write gate with the real scanner', () => {
  it('allows a write when only an exfiltration pattern overruns', async () => {
    findMany.mockResolvedValue([
      { ...SLOW, label: 'slow-exfil', type: 'EXFILTRATION' },
      BENIGN_INJECTION,
    ] as never);
    await expect(assertMemoryContentAllowed([SLOW_TEXT])).resolves.toBeUndefined();
    // And again once that pattern would be quarantined.
    await expect(assertMemoryContentAllowed([SLOW_TEXT])).resolves.toBeUndefined();
  });

  it('refuses a write when an injection pattern overruns', async () => {
    findMany.mockResolvedValue([
      { ...SLOW, label: 'slow-injection', type: 'INJECTION' },
      BENIGN_INJECTION,
    ] as never);
    const err = await assertMemoryContentAllowed([SLOW_TEXT]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryContentRefusedError);
    expect((err as MemoryContentRefusedError).reason).toBe('incomplete');
  });

  it('fails with a retryable error when the pattern set cannot be loaded', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    const err = await assertMemoryContentAllowed(['text']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryScanUnavailableError);
    expect(err).not.toBeInstanceOf(MemoryContentRefusedError);
  });
});

describe('memory recall with the real scanner', () => {
  it('recalls nothing when the pattern set cannot be loaded', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    const items = [{ s: 'one' }, { s: 'two' }];
    expect(await withoutFlaggedMemory(items, (i) => i.s)).toEqual([]);
  });

  it('keeps an item when only an injection pattern overran', async () => {
    findMany.mockResolvedValue([
      { ...SLOW, label: 'slow-injection', type: 'INJECTION' },
      BENIGN_INJECTION,
    ] as never);
    const items = [{ s: 'one' }];
    expect(await withoutFlaggedMemory(items, (i) => i.s)).toEqual(items);
  });

  it('withholds a lesson explanation when the pattern set cannot be loaded', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    memoryFindFirst.mockResolvedValue({
      agentKey: 'lessonConsolidator',
      confidence: 0.6,
      consolidatedAt: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      failureType: null,
      id: 'l1',
      lessonSummary: 'Pin the base image.',
      metadata: { evidence: { quote: 'a quote' }, outcome: 'MERGED' },
      rationale: 'Three runs broke on a moving tag.',
      supersededAt: null,
      workflowRunId: null,
    });
    memoryFindMany.mockResolvedValue([]);
    const out = await explainLesson('repo-1', 'l1');
    expect(out?.rationale).toBe('[withheld: matched an injection pattern]');
    expect((out?.evidence as { quote?: string } | null)?.quote).toBe(
      '[withheld: matched an injection pattern]'
    );
  });
});
