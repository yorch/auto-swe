import { describe, expect, it } from 'vitest';
import {
  type ExperimentRun,
  lessonRecallExperiment,
  rateDifference,
} from './lessonRecallExperiment.js';

function run(
  arm: ExperimentRun['lessonRecallArm'],
  overrides: Partial<ExperimentRun> = {}
): ExperimentRun {
  return {
    attributedPullRequests: [],
    costUsdAccrued: 2,
    evalResults: [],
    lessonRecallArm: arm,
    lessonRecallHeldOut: false,
    status: 'SUCCESS',
    steps: [],
    traces: [],
    ...overrides,
  };
}

describe('lesson recall outcome aggregation', () => {
  it('returns zero counts and unknown rates/means/intervals for empty arms', () => {
    const result = lessonRecallExperiment([]);
    expect(result.arms.ON).toMatchObject({
      gatePassRate: null,
      meanCostUsd: null,
      meanFixLoopIterations: null,
      mergeRate: null,
      runCount: 0,
      successRate: null,
    });
    expect(result.comparison).toMatchObject({ smallSample: true, successRateDifference: null });
    expect(result.likeForLike.ON.runCount).toBe(0);
  });
  it('deduplicates exposure/retries, uses latest gate outcomes, and leaves missing labels unknown', () => {
    const exposure = {
      outputJson: { lessons: [{ lessonId: 'l1' }] },
      toolName: 'lessons.retrieved',
    };
    const result = lessonRecallExperiment([
      run('ON', {
        attributedPullRequests: [{ status: 'MERGED' }],
        costUsdAccrued: 4,
        evalResults: [
          { passed: false, scorer: 'gate:test', source: 'GATE' },
          { passed: true, scorer: 'gate:test', source: 'GATE' },
          { passed: true, scorer: 'gate:lint', source: 'GATE' },
        ],
        lessonRecallHeldOut: false,
        steps: [
          { attempt: 1, nodeId: 'fix' },
          { attempt: 1, nodeId: 'fix' },
          { attempt: 2, nodeId: 'fix' },
        ],
        traces: [exposure, exposure],
      }),
      run('ON', {
        attributedPullRequests: [{ status: 'CLOSED' }],
        evalResults: [{ passed: false, scorer: 'gate:test', source: 'GATE' }],
        status: 'FAILED',
      }),
      run('ON', {
        attributedPullRequests: [{ status: 'OPEN' }],
        costUsdAccrued: 0,
        status: 'CANCELLED',
        traces: [{ outputJson: { lessons: [] }, toolName: 'lessons.retrieved' }],
      }),
      run('SHADOW', {
        evalResults: [{ passed: true, scorer: 'merge', source: 'MERGE' }],
        lessonRecallHeldOut: true,
        status: 'TIMED_OUT',
        traces: [
          {
            outputJson: { lessons: [{ lessonId: 'l2', similarity: 0.8 }] },
            toolName: 'lessons.shadow_retrieved',
          },
        ],
      }),
      run('SHADOW', {
        attributedPullRequests: [{ status: 'CLOSED' }, { status: 'OPEN' }],
        traces: [exposure],
      }),
      run('OFF', { status: 'SKIPPED' }),
      run(null),
    ]);
    expect(result.arms.ON).toMatchObject({
      failureRate: 0.5,
      gateKnownCount: 2,
      gatePassRate: 0.5,
      meanCostUsd: 2,
      mergeKnownCount: 2,
      mergeRate: 0.5,
      outcomeKnownCount: 2,
      runCount: 3,
      successRate: 0.5,
    });
    expect(result.arms.ON.meanFixLoopIterations).toBeCloseTo(2 / 3);
    expect(result.arms.SHADOW).toMatchObject({
      heldOutCount: 1,
      mergeKnownCount: 1,
      mergeRate: 1,
      runCount: 2,
    });
    expect(result.likeForLike.ON.runCount).toBe(1);
    expect(result.likeForLike.SHADOW.runCount).toBe(1);
    expect(result.likeForLike.comparison.successRateDifference?.difference).toBe(1);
    expect(result.arms.OFF).toMatchObject({ outcomeKnownCount: 0, runCount: 1, successRate: null });
    expect(result.caveat).toContain('not a causal effect');
  });
  it('ignores malformed/no-match traces and configured-shadow versus held-out labels remain separate', () => {
    const result = lessonRecallExperiment([
      run('SHADOW', {
        traces: [null, [], { lessons: 'not-an-array' }, { count: 1 }].map((outputJson) => ({
          outputJson,
          toolName: 'lessons.shadow_retrieved',
        })),
      }),
      run('ON', {
        traces: [{ outputJson: { lessons: ['untrusted tool output'] }, toolName: 'searchLessons' }],
      }),
    ]);
    expect(result.likeForLike.SHADOW.runCount).toBe(0);
    expect(result.likeForLike.ON.runCount).toBe(0);
    expect(result.arms.SHADOW.heldOutCount).toBe(0);
  });
  it('removes the small-sample marker with at least thirty runs in both comparison arms', () => {
    const runs = Array.from({ length: 30 }, () => [run('ON'), run('SHADOW')]).flat();
    const result = lessonRecallExperiment(runs);
    expect(result.comparison.smallSample).toBe(false);
    expect(result.likeForLike.comparison.smallSample).toBe(true);
  });
});

describe('95% rate-difference intervals', () => {
  it('is symmetric, bounded and remains nonzero-width for unanimous/single samples', () => {
    const interval = rateDifference(1, 1, 0, 1);
    expect(interval?.difference).toBe(1);
    expect(interval?.upper95).toBe(1);
    expect(interval?.lower95).toBeLessThan(0);
    const reverse = rateDifference(0, 1, 1, 1);
    expect(reverse?.lower95).toBe(-1);
    expect(reverse?.upper95).toBeCloseTo(-(interval?.lower95 ?? 0));
    const equal = rateDifference(50, 100, 50, 100);
    expect(equal?.difference).toBe(0);
    expect(equal?.lower95).toBeCloseTo(-0.136, 2);
    expect(equal?.upper95).toBeCloseTo(0.136, 2);
    expect(rateDifference(0, 0, 1, 1)).toBeNull();
  });
});
