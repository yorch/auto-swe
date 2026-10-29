import { describe, expect, it, vi } from 'vitest';
import { autoEvidenceSatisfied, prEvaluationEvidence } from './prEvaluationEvidence.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');

describe('prEvaluationEvidence', () => {
  it('counts LOW merges and bad merges within 90 days', async () => {
    const count = vi.fn(async (args: { where: { badMerge?: boolean } }) =>
      args.where.badMerge === true ? 2 : 160
    );
    const evidence = await prEvaluationEvidence({ prEvaluation: { count } }, NOW);
    expect(evidence).toEqual({ badMerges: 2, lowMerged: 160, windowDays: 90 });
    expect(count).toHaveBeenCalledTimes(2);
    const since = new Date('2026-07-31T12:00:00.000Z');
    for (const [args] of count.mock.calls) {
      expect(args.where).toMatchObject({ mergedAt: { gte: since }, riskClass: 'LOW' });
    }
    expect(count.mock.calls.some(([a]) => a.where.badMerge === true)).toBe(true);
  });
});

describe('autoEvidenceSatisfied', () => {
  it.each([
    [150, 0, 150, true],
    [149, 0, 150, false],
    [500, 1, 150, false],
    [0, 0, 0, true],
  ])('lowMerged=%i badMerges=%i min=%i -> %s', (lowMerged, badMerges, min, expected) => {
    expect(autoEvidenceSatisfied({ badMerges, lowMerged }, min)).toBe(expected);
  });
});
