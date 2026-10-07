import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./activityContext.js', () => ({ persistActivityTrace: vi.fn() }));

import { persistActivityTrace } from './activityContext.js';
import type { AgentTracer } from './agentTracer.js';
import {
  _resetRecallDropReportsForTests,
  RECALL_DROP_REPORT_TTL_MS,
  recordMemorySecurityEvent,
  unreportedRecallDrops,
} from './memorySecurityEvent.js';

const persist = vi.mocked(persistActivityTrace);

beforeEach(() => {
  persist.mockReset();
});

describe('recordMemorySecurityEvent', () => {
  it('persists one activity event for the current activity', async () => {
    persist.mockResolvedValue(true);
    await recordMemorySecurityEvent('memory.recall_dropped', { count: 1 });
    expect(persist).toHaveBeenCalledTimes(1);
    const [tracer, agentKey] = persist.mock.calls[0] as [AgentTracer, string];
    expect(agentKey).toBe('memoryGuard');
    expect(tracer.size).toBe(1);
  });

  it('never throws: outside an activity the event is only logged', async () => {
    persist.mockRejectedValue(new Error('not in activity context'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      recordMemorySecurityEvent('memory.recall_dropped', { count: 1 })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('logs a write that failed', async () => {
    persist.mockResolvedValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await recordMemorySecurityEvent('memory.recall_dropped', { count: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the write failed'));
    warn.mockRestore();
  });
});

describe('unreportedRecallDrops', () => {
  beforeEach(() => _resetRecallDropReportsForTests());

  it('returns an id once per TTL, and again once the TTL has passed', () => {
    expect(unreportedRecallDrops(['a', 'b'], 0)).toEqual(['a', 'b']);
    expect(unreportedRecallDrops(['a', 'c'], 1_000)).toEqual(['c']);
    expect(unreportedRecallDrops(['a'], RECALL_DROP_REPORT_TTL_MS + 1)).toEqual(['a']);
  });

  it('forgets the oldest ids past its bound, so it cannot grow without limit', () => {
    const ids = Array.from({ length: 1_001 }, (_, i) => `id-${i}`);
    unreportedRecallDrops(ids, 0);
    // id-0 was evicted, so it is reported again; id-1000 is still remembered.
    expect(unreportedRecallDrops(['id-0', 'id-1000'], 1)).toEqual(['id-0']);
  });
});
