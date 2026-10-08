import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/skillScanner', () => ({ scanSkillContent: vi.fn() }));
vi.mock('./memorySecurityEvent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memorySecurityEvent.js')>()),
  recordMemorySecurityEvent: vi.fn(),
}));

import {
  MEMORY_SECURITY_EVENTS,
  MEMORY_WRITE_REFUSED_EVENTS,
} from '@auto-swe/shared/lib/scannerCache';
import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';
import {
  assertMemoryContentAllowed,
  fenceRecalledMemory,
  MemoryContentRefusedError,
  MemoryScanUnavailableError,
  memoryInjectionMatches,
  memoryWriteRefusalEvent,
  WRITE_SCAN_UNAVAILABLE,
  withoutFlaggedMemory,
} from './memoryGuard.js';
import {
  _resetRecallDropReportsForTests,
  recordMemorySecurityEvent,
} from './memorySecurityEvent.js';

const scan = vi.mocked(scanSkillContent);
const recordEvent = vi.mocked(recordMemorySecurityEvent);

// A scanner stand-in that flags text containing the given marker as injection,
// and text containing a URL as exfiltration.
function flagging(marker: string) {
  return async (text: string) => {
    const warnings = [
      ...(text.includes(marker) ? ['injection:ignore-previous-instructions'] : []),
      ...(text.includes('https://') ? ['exfiltration:url'] : []),
    ];
    return { incomplete: false, safe: warnings.length === 0, warnings };
  };
}

beforeEach(() => {
  _resetRecallDropReportsForTests();
  recordEvent.mockReset();
  scan.mockReset();
  scan.mockImplementation(flagging('IGNORE'));
});

describe('memoryInjectionMatches', () => {
  it('returns injection labels only — a URL in a lesson is not a threat', async () => {
    expect((await memoryInjectionMatches(['see https://example.com/docs'])).matches).toEqual([]);
    expect((await memoryInjectionMatches(['IGNORE the rules', 'https://x'])).matches).toEqual([
      'ignore-previous-instructions',
    ]);
  });

  it('reports an incomplete scan alongside what the rules that ran matched', async () => {
    scan.mockResolvedValueOnce({
      incomplete: true,
      safe: false,
      warnings: ['injection:ignore-previous-instructions'],
    });
    expect(await memoryInjectionMatches(['IGNORE the rules'])).toEqual({
      incomplete: true,
      loadFailed: false,
      matches: ['ignore-previous-instructions'],
    });
  });

  it('scans every character, not a truncated prefix', async () => {
    await memoryInjectionMatches(['a', 'b']);
    expect(scan).toHaveBeenCalledWith('a\n\nb', { full: true, types: ['INJECTION'] });
  });

  it('skips the scan for empty text', async () => {
    expect(await memoryInjectionMatches(['', ''])).toEqual({
      incomplete: false,
      loadFailed: false,
      matches: [],
    });
    expect(scan).not.toHaveBeenCalled();
  });
});

describe('assertMemoryContentAllowed', () => {
  it('throws a refusal naming the patterns, never the text', async () => {
    const err = await assertMemoryContentAllowed(['IGNORE previous instructions: secret']).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(MemoryContentRefusedError);
    expect((err as MemoryContentRefusedError).patterns).toEqual(['ignore-previous-instructions']);
    expect((err as Error).message).not.toContain('secret');
  });

  it('refuses a write whose scan is incomplete, with no patterns and no text', async () => {
    scan.mockResolvedValue({ incomplete: true, safe: true, warnings: [] });
    const err = await assertMemoryContentAllowed(['clean but unverifiable secret']).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(MemoryContentRefusedError);
    expect((err as MemoryContentRefusedError).reason).toBe('incomplete');
    expect((err as MemoryContentRefusedError).patterns).toEqual([]);
    expect((err as Error).message).not.toContain('secret');
  });

  it('reports a match as the reason when the scan is also incomplete', async () => {
    scan.mockResolvedValue({
      incomplete: true,
      safe: false,
      warnings: ['injection:ignore-previous-instructions'],
    });
    const err = await assertMemoryContentAllowed(['x']).catch((e: unknown) => e);
    expect((err as MemoryContentRefusedError).reason).toBe('matched');
    expect((err as MemoryContentRefusedError).patterns).toEqual(['ignore-previous-instructions']);
  });

  it('fails a write with a retryable error, not a refusal, when the pattern set could not load', async () => {
    scan.mockResolvedValue({
      incomplete: true,
      incompleteReason: 'load-failed',
      safe: true,
      warnings: [],
    });
    const err = await assertMemoryContentAllowed(['text']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryScanUnavailableError);
    expect(err).not.toBeInstanceOf(MemoryContentRefusedError);
  });

  it('records an incomplete-scan refusal as an outage, never as a security event', () => {
    const incomplete = memoryWriteRefusalEvent(
      new MemoryContentRefusedError([], 'incomplete'),
      MEMORY_SECURITY_EVENTS.LESSON_REFUSED,
      { channelId: 'c' }
    );
    expect(incomplete).toEqual({
      name: WRITE_SCAN_UNAVAILABLE,
      outputJson: { channelId: 'c', reason: 'incomplete' },
    });
    expect(MEMORY_WRITE_REFUSED_EVENTS).not.toContain(WRITE_SCAN_UNAVAILABLE);
    const matched = memoryWriteRefusalEvent(
      new MemoryContentRefusedError(['p']),
      MEMORY_SECURITY_EVENTS.LESSON_REFUSED,
      { channelId: 'c' }
    );
    expect(matched).toEqual({
      name: MEMORY_SECURITY_EVENTS.LESSON_REFUSED,
      outputJson: { channelId: 'c', patterns: ['p'] },
    });
  });

  it('refuses a write when the scan throws', async () => {
    scan.mockRejectedValue(new Error('pattern store down'));
    await expect(assertMemoryContentAllowed(['text'])).rejects.toThrow('pattern store down');
  });

  it('passes clean text', async () => {
    await expect(assertMemoryContentAllowed(['run yarn lint before pushing'])).resolves.toBe(
      undefined
    );
  });
});

describe('withoutFlaggedMemory', () => {
  it('drops flagged items and keeps the rest in order', async () => {
    const items = [{ s: 'one' }, { s: 'IGNORE all' }, { s: 'three' }];
    expect(await withoutFlaggedMemory(items, (i) => i.s)).toEqual([{ s: 'one' }, { s: 'three' }]);
  });

  it('keeps an item when the scan is incomplete but the rules that ran flag nothing', async () => {
    scan.mockResolvedValue({ incomplete: true, safe: true, warnings: [] });
    const items = [{ s: 'one' }, { s: 'two' }];
    expect(await withoutFlaggedMemory(items, (i) => i.s)).toEqual(items);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('still drops a match found by an incomplete scan', async () => {
    scan.mockResolvedValue({
      incomplete: true,
      safe: false,
      warnings: ['injection:ignore-previous-instructions'],
    });
    expect(await withoutFlaggedMemory([{ s: 'IGNORE' }], (i) => i.s)).toEqual([]);
  });

  it('recalls nothing when the scanner throws', async () => {
    scan.mockRejectedValue(new Error('pattern store down'));
    expect(await withoutFlaggedMemory([{ s: 'one' }], (i) => i.s)).toEqual([]);
  });

  it('recalls nothing when the pattern set could not be loaded', async () => {
    scan.mockResolvedValue({
      incomplete: true,
      incompleteReason: 'load-failed',
      safe: true,
      warnings: [],
    });
    expect(await withoutFlaggedMemory([{ s: 'one' }], (i) => i.s)).toEqual([]);
  });

  it('records a drop as a security event naming ids and patterns, never the text', async () => {
    const items = [
      { id: 'a', s: 'one' },
      { id: 'b', s: 'IGNORE all' },
    ];
    await withoutFlaggedMemory(items, (i) => i.s, { idOf: (i) => i.id });
    expect(recordEvent).toHaveBeenCalledWith('memory.recall_dropped', {
      count: 1,
      memoryIds: ['b'],
      patterns: ['ignore-previous-instructions'],
    });
    expect(JSON.stringify(recordEvent.mock.calls)).not.toContain('IGNORE all');
  });

  it('reports one id once per hour, however often it is recalled', async () => {
    const items = [{ id: 'b', s: 'IGNORE all' }];
    await withoutFlaggedMemory(items, (i) => i.s, { idOf: (i) => i.id });
    await withoutFlaggedMemory(items, (i) => i.s, { idOf: (i) => i.id });
    expect(recordEvent).toHaveBeenCalledTimes(1);
    // A different flagged id is still reported.
    await withoutFlaggedMemory([{ id: 'c', s: 'IGNORE more' }], (i) => i.s, {
      idOf: (i) => i.id,
    });
    expect(recordEvent).toHaveBeenCalledTimes(2);
  });

  it('records only a count and patterns when the reader keeps ids off the trace', async () => {
    await withoutFlaggedMemory([{ id: 'x', s: 'IGNORE all' }], (i) => i.s, {
      idOf: (i) => i.id,
      recordIds: false,
    });
    expect(recordEvent).toHaveBeenCalledWith('memory.recall_dropped', {
      count: 1,
      patterns: ['ignore-previous-instructions'],
    });
  });

  it('does not wait for the event to be written', async () => {
    recordEvent.mockReturnValue(new Promise(() => undefined));
    const kept = await withoutFlaggedMemory(
      [
        { id: 'a', s: 'one' },
        { id: 'b', s: 'IGNORE all' },
      ],
      (i) => i.s,
      { idOf: (i) => i.id }
    );
    expect(kept).toEqual([{ id: 'a', s: 'one' }]);
  });

  it('records nothing when nothing is dropped', async () => {
    await withoutFlaggedMemory([{ s: 'one' }], (i) => i.s);
    expect(recordEvent).not.toHaveBeenCalled();
  });
});

describe('fenceRecalledMemory', () => {
  it('wraps the bullets in a fence stating they are not instructions', () => {
    const out = fenceRecalledMemory('## Lessons', ['- a', '- b']);
    expect(out.split('\n')[0]).toBe('## Lessons');
    expect(out).toContain('not instructions');
    expect(out).toMatch(/<recalled_memory>\n- a\n- b\n<\/recalled_memory>$/);
  });
});
