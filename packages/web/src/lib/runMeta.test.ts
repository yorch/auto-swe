import { describe, expect, it } from 'vitest';
import { runMetaSummary } from './runMeta';

const base = {
  costUsdAccrued: 0,
  endedAt: null,
  startedAt: '2026-10-01T12:00:00Z',
  tokensInputTotal: 0,
  tokensOutputTotal: 0,
};

describe('runMetaSummary', () => {
  it('is empty for a run that has produced none of the facts', () => {
    expect(runMetaSummary(base)).toEqual([]);
  });

  it('names the duration only once the run has ended', () => {
    expect(runMetaSummary({ ...base, endedAt: '2026-10-01T12:08:00Z' })).toEqual(['8m']);
  });

  it('adds cost and total tokens when there are any, in that order', () => {
    const parts = runMetaSummary({
      ...base,
      costUsdAccrued: 1.2345,
      endedAt: '2026-10-01T12:08:00Z',
      tokensInputTotal: 450_000,
      tokensOutputTotal: 100_000,
    });
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('8m');
    expect(parts[1]).toBe('$1.23');
    expect(parts[2]).toMatch(/tokens$/);
  });

  it('leaves out a zero cost rather than printing a dash', () => {
    expect(runMetaSummary({ ...base, tokensInputTotal: 10 })).toEqual(['10 tokens']);
  });
});
