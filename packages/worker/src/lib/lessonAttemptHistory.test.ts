import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findManyMock } = vi.hoisted(() => ({ findManyMock: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { agentTrace: { findMany: findManyMock } } }));

import { CI_FAILURE_TRACE_EVENT } from './attemptTrace.js';
import {
  type AttemptTraceRow,
  buildAttemptHistory,
  ENTRIES_KEPT,
  hasMoreThanLatest,
  KIND_TEXT_LIMIT,
  ROW_LIMIT,
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
    temporalRunId: 'temporal-run-1',
    toolName: null,
    ...r,
  }));
}

const REVIEWERS = ['SECURITY', 'DOMAIN_LOGIC', 'PERFORMANCE'];

const verdict = (
  reviewer: string,
  approved: boolean,
  description = `${reviewer} issue`,
  activityId?: string
) => ({
  outputJson: {
    ...(activityId ? { activityId } : {}),
    approved,
    findings: approved
      ? []
      : [{ category: 'BUG', description, file: 'src/a.ts', line: 3, suggestedFix: 'fix it' }],
    reviewer,
    severity: approved ? 'PASS' : 'WARNING',
  },
  toolName: reviewer,
});

/** One review dispatch's rows; `activityId` as the review network now stamps it. */
const review = (
  rejectedBy: string | null,
  opts: { description?: string; attempt?: number; activityId?: string } = {}
) =>
  batch(
    'review',
    REVIEWERS.map((r) => verdict(r, r !== rejectedBy, opts.description, opts.activityId)),
    opts.attempt
  );

const ciFix = (logTail: string, opts: { attempt?: number; activityId?: string } = {}) =>
  batch(
    'ciFix',
    [
      {
        outputJson: { ...(opts.activityId ? { activityId: opts.activityId } : {}), logTail },
        toolName: CI_FAILURE_TRACE_EVENT,
      },
    ],
    opts.attempt
  );

beforeEach(() => {
  clock = 0;
  findManyMock.mockReset();
});

describe('buildAttemptHistory', () => {
  it('keeps every rejected review dispatch, oldest first, worded as the fixer saw it', () => {
    const rows = [
      ...review('SECURITY', { activityId: '5', description: 'unvalidated input' }),
      ...review('PERFORMANCE', { activityId: '9', description: 'N+1 query' }),
      ...review(null, { activityId: '14' }),
    ];
    const history = buildAttemptHistory(rows, []);
    expect(history.reviewRejections).toEqual([
      {
        n: 1,
        text: '[SECURITY/WARNING] [BUG] src/a.ts:3 — unvalidated input — Suggested fix: fix it',
      },
      {
        n: 2,
        text: '[PERFORMANCE/WARNING] [BUG] src/a.ts:3 — N+1 query — Suggested fix: fix it',
      },
    ]);
    expect(history.omitted).toEqual({ ciFailures: 0, reviewRejections: 0 });
  });

  it('keeps every CI failure a fix session was handed', () => {
    const history = buildAttemptHistory(
      [],
      [...ciFix('FAIL lint', { activityId: '7' }), ...ciFix('FAIL types', { activityId: '12' })]
    );
    expect(history.ciFailures).toEqual([
      { n: 1, text: 'FAIL lint' },
      { n: 2, text: 'FAIL types' },
    ]);
  });

  it('counts a Temporal retry of one scheduled activity once, keeping its last attempt', () => {
    const rows = [
      // All three reviewers failed, so Temporal retried the activity.
      ...batch(
        'review',
        REVIEWERS.map((r) => ({
          error: 'overloaded',
          outputJson: { activityId: '5' },
          toolName: r,
        }))
      ),
      ...review('DOMAIN_LOGIC', { activityId: '5', attempt: 2, description: 'wrong total' }),
    ];
    const ci = [
      ...ciFix('first try', { activityId: '7' }),
      ...ciFix('retried', { activityId: '7', attempt: 2 }),
      ...ciFix('next failure', { activityId: '12' }),
    ];
    const history = buildAttemptHistory(rows, ci);
    expect(history.reviewRejections.map((e) => e.text)).toEqual([
      expect.stringContaining('wrong total'),
    ]);
    expect(history.ciFailures.map((e) => e.text)).toEqual(['retried', 'next failure']);
  });

  it('never lets a retry stand in for an earlier fix when its first attempt wrote nothing', () => {
    // Fix #2's attempt 1 failed before its tracer existed (a clone blip), so only its attempt 2
    // wrote a row. It is a different scheduled activity from fix #1, which must stay.
    const ci = [
      ...ciFix('FAIL lint', { activityId: '7' }),
      ...ciFix('FAIL types', { activityId: '12', attempt: 2 }),
    ];
    // Likewise a review whose attempt 1 threw before any reviewer ran.
    const rows = [
      ...review('SECURITY', { activityId: '5', description: 'round one' }),
      ...review('SECURITY', { activityId: '9', attempt: 2, description: 'round two' }),
    ];
    const history = buildAttemptHistory(rows, ci);
    expect(history.ciFailures.map((e) => e.text)).toEqual(['FAIL lint', 'FAIL types']);
    expect(history.reviewRejections.map((e) => e.text)).toEqual([
      expect.stringContaining('round one'),
      expect.stringContaining('round two'),
    ]);
  });

  it('keeps every row without an activity id, grouped by its batch', () => {
    const rows = [
      ...review('SECURITY', { description: 'one' }),
      ...review('SECURITY', { attempt: 2, description: 'two' }),
    ];
    const history = buildAttemptHistory(rows, [...ciFix('a'), ...ciFix('b', { attempt: 2 })]);
    expect(history.reviewRejections).toHaveLength(2);
    expect(history.ciFailures.map((e) => e.text)).toEqual(['a', 'b']);
  });

  it('drops a CI failure that repeats the one before it, as a fix that changed nothing does', () => {
    const ci = [
      ...ciFix('FAIL lint', { activityId: '7' }),
      ...ciFix('FAIL lint', { activityId: '12' }),
      ...ciFix('FAIL types', { activityId: '17' }),
      ...ciFix('FAIL lint', { activityId: '22' }),
    ];
    expect(buildAttemptHistory([], ci).ciFailures.map((e) => e.text)).toEqual([
      'FAIL lint',
      'FAIL types',
      'FAIL lint',
    ]);
  });

  it('drops the oldest dispatch when the row bound may have cut it short', () => {
    const rows = [
      // Only the newest of this dispatch's three rows fit in the page.
      ...batch('review', [verdict('PERFORMANCE', true, '', '5')]),
      ...review('SECURITY', { activityId: '9', description: 'kept' }),
    ];
    expect(buildAttemptHistory(rows, [], { reviewRowsCut: true }).reviewRejections).toEqual([
      { n: 1, text: expect.stringContaining('kept') },
    ]);
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

  it("keeps a fan-out's concurrent reviewer branches apart", () => {
    const at = new Date(1_700_000_000_000);
    const branch = (i: number, description: string): AttemptTraceRow[] =>
      REVIEWERS.map((r) => ({
        attempt: 1,
        createdAt: at,
        error: null,
        recordingId: `fanOutReview[${i}]/runBranchReview`,
        temporalRunId: 'temporal-run-1',
        ...verdict(r, r !== 'SECURITY', description, String(10 + i)),
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

  it('keeps the latest entries and bounds each kind, the tail of a log and the head of a rejection', () => {
    const ci = Array.from({ length: ENTRIES_KEPT + 2 }, (_, i) =>
      ciFix(`${'x'.repeat(5_000)}END-${i + 1}`, { activityId: String(i) })
    ).flat();
    const rejections = Array.from({ length: 2 }, (_, i) =>
      review('SECURITY', { activityId: `r${i}`, description: `START-${i + 1}${'y'.repeat(5_000)}` })
    ).flat();
    const history = buildAttemptHistory(rejections, ci);

    expect(history.omitted.ciFailures).toBe(2);
    expect(history.ciFailures.map((e) => e.n)).toEqual([3, 4, 5, 6, 7]);
    for (const entry of history.ciFailures) {
      expect(entry.text).toMatch(/^\[… \d+ earlier characters\]\n/);
      expect(entry.text).toMatch(/END-\d$/);
    }
    for (const entry of history.reviewRejections) {
      expect(entry.text).toContain('START-');
      expect(entry.text).toMatch(/more characters\]$/);
    }
    // Each kept entry gets an equal share of its kind's limit, plus the elision marker.
    const size = (entries: Array<{ text: string }>) =>
      entries.reduce((n, e) => n + e.text.length, 0);
    expect(size(history.ciFailures)).toBeLessThan(KIND_TEXT_LIMIT + 200);
    expect(size(history.reviewRejections)).toBeLessThan(KIND_TEXT_LIMIT + 200);
  });
});

describe('hasMoreThanLatest', () => {
  const empty = {
    ciFailures: [],
    omitted: { ciFailures: 0, reviewRejections: 0 },
    reviewRejections: [],
  };
  it('is true only when some kind has more than its latest entry', () => {
    expect(hasMoreThanLatest(empty)).toBe(false);
    expect(hasMoreThanLatest({ ...empty, ciFailures: [{ n: 1, text: 'a' }] })).toBe(false);
    expect(
      hasMoreThanLatest({
        ...empty,
        ciFailures: [
          { n: 1, text: 'a' },
          { n: 2, text: 'b' },
        ],
      })
    ).toBe(true);
    expect(
      hasMoreThanLatest({
        ...empty,
        omitted: { ciFailures: 0, reviewRejections: 4 },
        reviewRejections: [{ n: 5, text: 'a' }],
      })
    ).toBe(true);
  });
});

describe('readLessonAttemptHistory', () => {
  it("reads only the run's own review and CI-failure rows, and puts them back in order", async () => {
    const older = ciFix('older', { activityId: '7' });
    const newer = ciFix('newer', { activityId: '12' });
    findManyMock.mockImplementation(async (args: { where: { type: string } }) =>
      args.where.type === 'activity_event' ? [...newer, ...older] : []
    );

    const history = await readLessonAttemptHistory('run-1');

    expect(history.ciFailures.map((e) => e.text)).toEqual(['older', 'newer']);
    expect(findManyMock.mock.calls.map(([args]) => args.where)).toEqual([
      { nodeId: 'runReviewNetwork', runId: 'run-1', type: 'llm_response' },
      { runId: 'run-1', toolName: CI_FAILURE_TRACE_EVENT, type: 'activity_event' },
    ]);
    for (const [args] of findManyMock.mock.calls) {
      expect(args.take).toBe(ROW_LIMIT);
    }
  });

  it('drops the oldest dispatch of a full page', async () => {
    const rows = Array.from({ length: ROW_LIMIT / 3 }, (_, i) =>
      review('SECURITY', { activityId: String(i), description: `round ${i}` })
    ).flat();
    findManyMock.mockImplementation(async (args: { where: { type: string } }) =>
      args.where.type === 'llm_response' ? [...rows].reverse() : []
    );
    const history = await readLessonAttemptHistory('run-1');
    expect(history.omitted.reviewRejections + history.reviewRejections.length).toBe(
      ROW_LIMIT / 3 - 1
    );
    expect(history.reviewRejections.at(-1)?.text).toContain(`round ${ROW_LIMIT / 3 - 1}`);
  });

  it('throws when the read fails, for the caller to fall back', async () => {
    findManyMock.mockRejectedValue(new Error('pg down'));
    await expect(readLessonAttemptHistory('run-1')).rejects.toThrow('pg down');
  });
});
