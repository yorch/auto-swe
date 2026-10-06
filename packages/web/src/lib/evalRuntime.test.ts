import { describe, expect, it } from 'vitest';
import { formatArm, resultRuntimes, runtimeLabel } from './evalRuntime';

describe('evalRuntime', () => {
  it('labels known runtimes and passes an unknown one through', () => {
    expect(runtimeLabel('claude-code')).toBe('Claude Code harness');
    expect(runtimeLabel('mastra')).toBe('Mastra loop');
    expect(runtimeLabel('other')).toBe('other');
    expect(runtimeLabel(null)).toBeNull();
  });

  it('names the runtime only on a side that overrode it', () => {
    expect(formatArm('implementer@3', 'claude-code')).toBe('implementer@3 on Claude Code harness');
    expect(formatArm('implementer@3', null)).toBe('implementer@3');
  });

  it('reads the candidate runtime from its column and the baseline from metadata', () => {
    expect(
      resultRuntimes({ metadata: { baselineRuntime: 'mastra', tags: [] }, runtime: 'claude-code' })
    ).toEqual({ baseline: 'mastra', candidate: 'claude-code' });
    expect(resultRuntimes({ metadata: null, runtime: null })).toEqual({
      baseline: null,
      candidate: null,
    });
  });
});
