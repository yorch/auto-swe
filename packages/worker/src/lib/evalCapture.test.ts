import type { ReviewVerdict } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { evalResult: { create: createMock } },
}));

import type { GateResult } from '../activities/qualityGates.js';
import {
  REVIEW_SEVERITY_SCORE,
  recordEvalResult,
  recordGateEval,
  recordReviewEval,
} from './evalCapture.js';

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue({ id: 'row-1' });
});

describe('REVIEW_SEVERITY_SCORE', () => {
  it('maps severities to the documented scale', () => {
    expect(REVIEW_SEVERITY_SCORE).toEqual({
      CRITICAL: 0.0,
      INFO: 0.9,
      PASS: 1.0,
      WARNING: 0.5,
    });
  });
});

describe('recordEvalResult', () => {
  it('writes a normalized row', async () => {
    await recordEvalResult({
      runId: 'run-1',
      scorer: 'gate:runTests',
      scoreType: 'BOOLEAN',
      source: 'GATE',
      value: 1,
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].data).toMatchObject({
      runId: 'run-1',
      scorer: 'gate:runTests',
      source: 'GATE',
      value: 1,
    });
  });

  it('is best-effort: a DB throw is swallowed, never propagated', async () => {
    createMock.mockRejectedValueOnce(new Error('db down'));
    await expect(
      recordEvalResult({ scorer: 'merge', scoreType: 'BOOLEAN', source: 'MERGE', value: 0 })
    ).resolves.toBeUndefined();
  });

  it('omits metadata when not provided', async () => {
    await recordEvalResult({ scorer: 's', scoreType: 'NUMERIC', source: 'REVIEW', value: 0.5 });
    expect(createMock.mock.calls[0][0].data).not.toHaveProperty('metadata');
  });
});

describe('recordGateEval', () => {
  it('maps a passing gate to value 1 with the gate scorer', async () => {
    const gate: GateResult = { exitCode: 0, passed: true, summary: 'ok' };
    await recordGateEval('runTests', gate, 'run-1');
    expect(createMock.mock.calls[0][0].data).toMatchObject({
      nodeId: 'runTests',
      passed: true,
      runId: 'run-1',
      scorer: 'gate:runTests',
      scoreType: 'BOOLEAN',
      source: 'GATE',
      value: 1,
    });
  });

  it('maps a failing gate to value 0', async () => {
    const gate: GateResult = { exitCode: 1, passed: false, summary: 'boom' };
    await recordGateEval('runLint', gate);
    expect(createMock.mock.calls[0][0].data).toMatchObject({ passed: false, value: 0 });
  });
});

describe('recordReviewEval', () => {
  it('writes one row per verdict with severity → numeric value', async () => {
    const verdicts: ReviewVerdict[] = [
      { approved: true, findings: [], reviewer: 'SECURITY', severity: 'PASS' },
      {
        approved: false,
        findings: [{ category: 'x', description: 'd', file: 'a.ts', suggestedFix: 'fix' }],
        reviewer: 'DOMAIN_LOGIC',
        severity: 'CRITICAL',
      },
    ];
    await recordReviewEval(verdicts, 'run-1');
    expect(createMock).toHaveBeenCalledTimes(2);
    const rows = createMock.mock.calls.map((c) => c[0].data);
    expect(rows).toContainEqual(
      expect.objectContaining({ scorer: 'review:SECURITY', source: 'REVIEW', value: 1.0 })
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ passed: false, scorer: 'review:DOMAIN_LOGIC', value: 0.0 })
    );
  });

  it('does not throw when there are no verdicts', async () => {
    await expect(recordReviewEval([], 'run-1')).resolves.toBeUndefined();
    expect(createMock).not.toHaveBeenCalled();
  });
});
