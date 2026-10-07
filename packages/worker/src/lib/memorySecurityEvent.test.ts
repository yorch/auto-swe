import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./activityContext.js', () => ({ persistActivityTrace: vi.fn() }));

import { persistActivityTrace } from './activityContext.js';
import type { AgentTracer } from './agentTracer.js';
import { recordMemorySecurityEvent } from './memorySecurityEvent.js';

const persist = vi.mocked(persistActivityTrace);

beforeEach(() => {
  persist.mockReset();
});

describe('recordMemorySecurityEvent', () => {
  it('persists one activity event for the current activity', async () => {
    persist.mockResolvedValue(undefined);
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
});
