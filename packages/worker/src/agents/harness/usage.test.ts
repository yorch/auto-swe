import { describe, expect, it } from 'vitest';
import { runningTotalsUsage, summedCallsUsage } from './usage.js';

const t = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  cacheRead,
  cacheWrite,
  input,
  output,
});

describe('runningTotalsUsage', () => {
  it('records the change since the last report, cache traffic counted as input and apart', () => {
    const usage = runningTotalsUsage('p/');
    expect(usage.normalise({ m: t(100, 10, 50, 5) })).toEqual([
      {
        modelSpec: 'p/m',
        usage: {
          cacheCreationInputTokens: 5,
          cachedInputTokens: 50,
          inputTokens: 155,
          outputTokens: 10,
        },
      },
    ]);
    expect(usage.normalise({ m: t(130, 12, 50, 5) })[0]?.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 2,
    });
  });

  it('counts a total that went backwards whole, and leaves out a model that spent nothing', () => {
    const usage = runningTotalsUsage('p/');
    usage.normalise({ a: t(500, 50), b: t(10, 1) });
    expect(usage.normalise({ a: t(40, 4), b: t(10, 1) })).toEqual([
      {
        modelSpec: 'p/a',
        usage: {
          cacheCreationInputTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 40,
          outputTokens: 4,
        },
      },
    ]);
  });
});

describe('summedCallsUsage', () => {
  it('sums per-call reports per model, largest spender first', () => {
    expect(
      summedCallsUsage('p/', [
        { model: 'small', usage: t(10, 1) },
        { model: 'big', usage: t(100, 20, 30) },
        { model: 'big', usage: t(5, 5, 0, 2) },
      ])
    ).toEqual([
      {
        modelSpec: 'p/big',
        usage: {
          cacheCreationInputTokens: 2,
          cachedInputTokens: 30,
          inputTokens: 137,
          outputTokens: 25,
        },
      },
      {
        modelSpec: 'p/small',
        usage: {
          cacheCreationInputTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 10,
          outputTokens: 1,
        },
      },
    ]);
  });
});
