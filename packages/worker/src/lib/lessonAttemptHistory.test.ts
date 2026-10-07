import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findManyMock } = vi.hoisted(() => ({ findManyMock: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { agentTrace: { findMany: findManyMock } } }));

import { CI_FAILURE_TRACE_EVENT } from './attemptTrace.js';
import {
  ATTEMPT_KIND_TEXT_LIMIT,
  ATTEMPTS_KEPT,
  type AttemptTraceRow,
  buildAttemptHistory,
  hasEarlierAttempts,
  readLessonAttemptHistory,
} from './lessonAttemptHistory.js';

let clock = 0;
/** One persisted batch: the rows of one activity attempt share its insert's timestamp. */
function batch(
  recordingId: string,
  rows: Array<Partial<AttemptTraceRow>>,
  attempt = 1
): AttemptTraceRow[] {
  const createdAt = new Date(1_700_000_000_000 + clock++ * 1_000);
  return rows.map((r) => ({
    attempt,
    createdAt,
    error: null,
    outputJson: null,
    recordingId,
    toolName: null,
    ...r,
  }));
}

const verdict = (reviewer: string, approved: boolean, description = `${reviewer} issue`) => ({
  outputJson: {
    approved,
    findings: approved
      ? []
      : [{ category: 'BUG', description, file: 'src/a.ts', line: 3, suggestedFix: 'fix it' }],
    reviewer,
    severity: approved ? 'PASS' : 'WARNING',
  },
  toolName: reviewer,
});

const review = (rejectedBy: string | null, description?: string, attempt = 1) =>
  batch(
    'review',
    ['SECURITY', 'DOMAIN_LOGIC', 'PERFORMANCE'].map((r) =>
      verdict(r, r !== rejectedBy, description)
    ),
    attempt
  );

const ciFix = (logTail: string, attempt = 1) =>
  batch('ciFix', [{ outputJson: { logTail }, toolName: CI_FAILURE_TRACE_EVENT }], attempt);

beforeEach(() => {
  clock = 0;
  findManyMock.mockReset();
});

describe('buildAttemptHistory', () => {
  it('keeps every rejected review dispatch, oldest first, worded as the fixer saw it', () => {
    const rows = [
      ...review('SECURITY', 'unvalidated input'),
      ...review('PERFORMANCE', 'N+1 query'),
      ...review(null),
    ];
    const history = buildAttemptHistory(rows, []);
    expect(history.reviewRejections).toEqual([
      {
        attempt: 1,
        text: '[SECURITY/WARNING] [BUG] src/a.ts:3 — unvalidated input — Suggested fix: fix it',
      },
      {
        attempt: 2,
        text: '[PERFORMANCE/WARNING] [BUG] src/a.ts:3 — N+1 query — Suggested fix: fix it',
      },
    ]);
    expect(history.omitted).toEqual({ ciFailures: 0, reviewRejections: 0 });
  });

  it('keeps every CI failure a fix session was handed', () => {
    const history = buildAttemptHistory([], [...ciFix('FAIL lint'), ...ciFix('FAIL types')]);
    expect(history.ciFailures).toEqual([
      { attempt: 1, text: 'FAIL lint' },
      { attempt: 2, text: 'FAIL types' },
    ]);
  });

  it('counts a Temporal retry of one dispatch once, keeping its last attempt', () => {
    const rows = [
      // All three reviewers failed, so Temporal retried the activity.
      ...batch(
        'review',
        ['SECURITY', 'DOMAIN_LOGIC', 'PERFORMANCE'].map((r) => ({
          error: 'overloaded',
          toolName: r,
        }))
      ),
      ...review('DOMAIN_LOGIC', 'wrong total', 2),
    ];
    const ci = [...ciFix('first try'), ...ciFix('retried', 2), ...ciFix('next failure')];
    const history = buildAttemptHistory(rows, ci);
    expect(history.reviewRejections.map((e) => e.text)).toEqual([
      expect.stringContaining('wrong total'),
    ]);
    expect(history.ciFailures.map((e) => e.text)).toEqual(['retried', 'next failure']);
  });

  it('counts a crashed reviewer as a critical rejection, as the review network does', () => {
    const rows = batch('review', [
      verdict('SECURITY', true),
      { error: 'provider timeout', toolName: 'DOMAIN_LOGIC' },
      verdict('PERFORMANCE', true),
    ]);
    expect(buildAttemptHistory(rows, []).reviewRejections[0]?.text).toBe(
      '[DOMAIN_LOGIC/CRITICAL] [REVIEWER_CRASH]  — Reviewer agent failed: provider timeout — ' +
        'Suggested fix: Manual review required'
    );
  });

  it("separates a fan-out's concurrent reviewer branches by their recording ids", () => {
    const at = new Date(1_700_000_000_000);
    const branch = (i: number, description: string): AttemptTraceRow[] =>
      ['SECURITY', 'DOMAIN_LOGIC', 'PERFORMANCE'].map((r) => ({
        attempt: 1,
        createdAt: at,
        error: null,
        recordingId: `fanOutReview[${i}]/runBranchReview`,
        ...verdict(r, r !== 'SECURITY', description),
      }));
    const history = buildAttemptHistory([...branch(0, 'one'), ...branch(1, 'two')], []);
    expect(history.reviewRejections.map((e) => e.text)).toEqual([
      expect.stringContaining('one'),
      expect.stringContaining('two'),
    ]);
  });

  it('ignores rows that are not a verdict or a log', () => {
    const rows = batch('review', [{ outputJson: { text: 'not a verdict' } }]);
    const ci = batch('ciFix', [{ outputJson: { logTail: '   ' } }, { outputJson: 'x' }]);
    expect(buildAttemptHistory(rows, ci)).toEqual({
      ciFailures: [],
      omitted: { ciFailures: 0, reviewRejections: 0 },
      reviewRejections: [],
    });
  });

  it('keeps the latest attempts and bounds each kind, the tail of a log and the head of a rejection', () => {
    const ci = Array.from({ length: ATTEMPTS_KEPT + 2 }, (_, i) =>
      ciFix(`${'x'.repeat(5_000)}END-${i + 1}`)
    ).flat();
    const rejections = Array.from({ length: 2 }, (_, i) =>
      review('SECURITY', `START-${i + 1}${'y'.repeat(5_000)}`)
    ).flat();
    const history = buildAttemptHistory(rejections, ci);

    expect(history.omitted.ciFailures).toBe(2);
    expect(history.ciFailures.map((e) => e.attempt)).toEqual([3, 4, 5, 6, 7]);
    for (const entry of history.ciFailures) {
      expect(entry.text).toMatch(/^\[… \d+ earlier characters\]\n/);
      expect(entry.text).toMatch(/END-\d$/);
    }
    for (const entry of history.reviewRejections) {
      expect(entry.text).toContain('START-');
      expect(entry.text).toMatch(/more characters\]$/);
    }
    // Each kept attempt gets an equal share of its kind's limit, plus the elision marker.
    const size = (entries: Array<{ text: string }>) =>
      entries.reduce((n, e) => n + e.text.length, 0);
    expect(size(history.ciFailures)).toBeLessThan(ATTEMPT_KIND_TEXT_LIMIT + 200);
    expect(size(history.reviewRejections)).toBeLessThan(ATTEMPT_KIND_TEXT_LIMIT + 200);
  });
});

describe('hasEarlierAttempts', () => {
  const empty = {
    ciFailures: [],
    omitted: { ciFailures: 0, reviewRejections: 0 },
    reviewRejections: [],
  };
  it('is true only when some kind has more than the latest attempt', () => {
    expect(hasEarlierAttempts(empty)).toBe(false);
    expect(hasEarlierAttempts({ ...empty, ciFailures: [{ attempt: 1, text: 'a' }] })).toBe(false);
    expect(
      hasEarlierAttempts({
        ...empty,
        ciFailures: [
          { attempt: 1, text: 'a' },
          { attempt: 2, text: 'b' },
        ],
      })
    ).toBe(true);
    expect(
      hasEarlierAttempts({
        ...empty,
        omitted: { ciFailures: 0, reviewRejections: 4 },
        reviewRejections: [{ attempt: 5, text: 'a' }],
      })
    ).toBe(true);
  });
});

describe('readLessonAttemptHistory', () => {
  it("reads only the run's own review and CI-failure rows, and puts them back in order", async () => {
    const [older, newer] = [ciFix('older'), ciFix('newer')];
    findManyMock.mockImplementation(async (args: { where: { type: string } }) =>
      args.where.type === 'activity_event' ? [...(newer ?? []), ...(older ?? [])] : []
    );

    const history = await readLessonAttemptHistory('run-1');

    expect(history.ciFailures.map((e) => e.text)).toEqual(['older', 'newer']);
    expect(findManyMock).toHaveBeenCalledTimes(2);
    for (const [args] of findManyMock.mock.calls) {
      expect(args.where.runId).toBe('run-1');
      expect(args.take).toBeGreaterThan(0);
    }
    expect(findManyMock.mock.calls.map(([args]) => args.where)).toEqual([
      { nodeId: 'runReviewNetwork', runId: 'run-1', type: 'llm_response' },
      { runId: 'run-1', toolName: CI_FAILURE_TRACE_EVENT, type: 'activity_event' },
    ]);
  });

  it('throws when the read fails, for the caller to fall back', async () => {
    findManyMock.mockRejectedValue(new Error('pg down'));
    await expect(readLessonAttemptHistory('run-1')).rejects.toThrow('pg down');
  });
});
