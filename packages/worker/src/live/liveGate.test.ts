import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveGate, liveTitle } from './liveGate.js';

describe('liveGate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('skips quietly when the flag is not set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = liveGate('s', 'LIVE_X', false, ['A'], {});
    expect(gate).toEqual({ enabled: false, reason: 'LIVE_X is not 1' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('names every missing credential when the flag is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = liveGate('s', 'LIVE_X', true, ['A', 'B', 'C'], { B: 'x' });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe('LIVE_X=1 but A, C are not set');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('annotates the skip as a GitHub warning in Actions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    liveGate('s', 'LIVE_X', true, ['A'], { GITHUB_ACTIONS: 'true' });
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^::warning::/);
  });

  it('runs when the flag and every credential are present', () => {
    const gate = liveGate('s', 'LIVE_X', true, ['A'], { A: '1' });
    expect(gate).toEqual({ enabled: true, reason: undefined });
    expect(liveTitle('suite', gate)).toBe('suite');
  });

  it('puts the reason in the title of a skipped suite', () => {
    const gate = liveGate('s', 'LIVE_X', false, [], {});
    expect(liveTitle('suite', gate)).toBe('suite (skipped: LIVE_X is not 1)');
  });
});
