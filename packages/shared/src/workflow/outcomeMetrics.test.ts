import { describe, expect, it } from 'vitest';
import {
  computeOutcomeReport,
  type OutcomePullRequest,
  type OutcomeRun,
  renderOutcomeReportMarkdown,
  workItemKeyFor,
} from './outcomeMetrics.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 10);
const window = { end: new Date(T0 + 30 * 24 * H), start: new Date(T0 - 24 * H) };
const generatedAt = new Date(T0 + 40 * 24 * H);

function run(id: string, over: Partial<OutcomeRun> = {}): OutcomeRun {
  return {
    costUsd: 1,
    id,
    repoId: 'repo-a',
    repoName: 'acme/a',
    startedAt: new Date(T0),
    status: 'SUCCESS',
    templateId: 't1',
    templateName: 'Engineering',
    workItemKey: `run:${id}`,
    ...over,
  };
}

function pr(runId: string, over: Partial<OutcomePullRequest> = {}): OutcomePullRequest {
  return { ciStatus: 'PASSED', mergedAt: null, runId, status: 'OPEN', ...over };
}

describe('workItemKeyFor', () => {
  const base = {
    id: 'r',
    repoId: 'repo',
    ticketId: 'PAY-1',
    ticketIsSynthetic: false,
    workRequestId: 'w',
  };
  it('groups real tickets by repository, ignoring case', () => {
    expect(workItemKeyFor(base)).toBe(
      workItemKeyFor({ ...base, id: 'r2', ticketId: 'pay-1', workRequestId: 'w2' })
    );
    expect(workItemKeyFor(base)).not.toBe(workItemKeyFor({ ...base, repoId: 'other' }));
  });
  it('groups a synthetic ticket by work request and a request-less run alone', () => {
    expect(workItemKeyFor({ ...base, ticketIsSynthetic: true })).toBe('request:w');
    expect(workItemKeyFor({ ...base, ticketId: null, workRequestId: null })).toBe('run:r');
  });
});

describe('computeOutcomeReport', () => {
  const runs = [
    // Merged after a failed first attempt: both attempts' cost belongs to the merged item.
    run('a1', { costUsd: 3, status: 'FAILED', workItemKey: 'k-a' }),
    run('a2', { costUsd: 2, startedAt: new Date(T0 + H), workItemKey: 'k-a' }),
    // Closed unmerged.
    run('b1', { costUsd: 4, workItemKey: 'k-b' }),
    // Ended with no pull request.
    run('c1', { costUsd: 1, status: 'FAILED', workItemKey: 'k-c' }),
    // Open PR (undecided), different template and repo.
    run('d1', {
      costUsd: 6,
      repoId: 'repo-b',
      repoName: 'acme/b',
      templateId: 't2',
      templateName: 'Docs',
      workItemKey: 'k-d',
    }),
    // Still running (undecided).
    run('e1', { costUsd: 5, status: 'RUNNING', workItemKey: 'k-e' }),
    // Started before the window: not in the cohort.
    run('old', { costUsd: 100, startedAt: new Date(T0 - 10 * 24 * H), workItemKey: 'k-old' }),
  ];
  const prs = [
    pr('a2', { mergedAt: new Date(T0 + 5 * H), status: 'MERGED' }),
    pr('b1', { ciStatus: 'FAILED', status: 'CLOSED' }),
    pr('d1', { status: 'OPEN' }),
  ];
  const steps = [
    { runId: 'a1', stepName: 'executeReviewFixImplementation' },
    { runId: 'a2', stepName: 'executeReviewFixImplementation' },
    { runId: 'a2', stepName: 'executeCIFixImplementation' },
    { runId: 'b1', stepName: 'executeCIFixImplementation' },
    { runId: 'd1', stepName: 'executeReviewFixImplementation' },
  ];
  const report = computeOutcomeReport({ generatedAt, pullRequests: prs, runs, steps, window });
  const o = report.overall;

  it('excludes work whose first run began before the window', () => {
    expect(o.workItems).toBe(5);
    expect(o.runs).toBe(6);
    expect(o.cost.totalUsd).toBe(21);
  });

  it('classifies items and keeps failures in the denominator', () => {
    expect(o.states).toEqual({ closed_unmerged: 1, merged: 1, no_pr: 1, open: 1, running: 1 });
    expect(o.settledItems).toBe(3);
    expect(o.mergeRate).toBeCloseTo(1 / 3);
    expect(o.decidedPrMergeRate).toBe(0.5);
    expect(o.lowSample).toBe(true);
    expect(o.runsByStatus).toEqual({ FAILED: 2, RUNNING: 1, SUCCESS: 3 });
  });

  it('counts the whole ticket history in cost per merged PR', () => {
    expect(o.prsMerged).toBe(1);
    expect(o.cost.mergedItemsUsd).toBe(5);
    expect(o.cost.unmergedSettledUsd).toBe(5);
    expect(o.cost.undecidedUsd).toBe(11);
    expect(o.cost.perMergedPr).toBe(21);
    expect(o.cost.perMergedPrSettled).toBe(10);
  });

  it('measures time to merge from the first attempt', () => {
    expect(o.timeToMergeMs).toEqual({ median: 5 * H, n: 1, p90: 5 * H });
  });

  it('counts review rounds across attempts, over items with a pull request', () => {
    expect(o.reviewRounds).toMatchObject({ itemsWithAnyRound: 2, itemsWithPr: 3, max: 2 });
    expect(o.reviewRounds.mean).toBeCloseTo(1);
    expect(o.reviewRounds.median).toBe(1);
  });

  it('scores CI heal over items that needed a fix and have a pull request', () => {
    expect(o.ciHeal).toMatchObject({ itemsHealed: 1, itemsWithCiFix: 2, rate: 0.5 });
  });

  it('slices by template and repository using the merging run', () => {
    expect(report.byTemplate.map((t) => [t.templateName, t.workItems])).toEqual([
      ['Engineering', 4],
      ['Docs', 1],
    ]);
    expect(report.byRepo.map((r) => [r.repoName, r.workItems])).toEqual([
      ['acme/a', 4],
      ['acme/b', 1],
    ]);
    expect(report.byTemplate[1]?.cost.perMergedPr).toBeNull();
  });

  it('is reproducible: the same rows give the same report', () => {
    const again = computeOutcomeReport({ generatedAt, pullRequests: prs, runs, steps, window });
    expect(again).toEqual(report);
    expect(renderOutcomeReportMarkdown(again)).toBe(renderOutcomeReportMarkdown(report));
  });

  it('returns nulls, not zeros or NaN, for an empty cohort', () => {
    const empty = computeOutcomeReport({
      generatedAt,
      pullRequests: [],
      runs: [],
      steps: [],
      window,
    });
    expect(empty.overall).toMatchObject({
      ciHeal: { rate: null },
      cost: { perMergedPr: null, totalUsd: 0 },
      mergeRate: null,
      timeToMergeMs: { median: null, n: 0 },
      workItems: 0,
    });
  });

  it('renders failures and the low-sample mark, and escapes table cells', () => {
    const md = renderOutcomeReportMarkdown(
      computeOutcomeReport({
        generatedAt,
        pullRequests: prs,
        runs: runs.map((r) => (r.id === 'd1' ? { ...r, templateName: 'Docs | draft\nx' } : r)),
        steps,
        window,
      })
    );
    expect(md).toContain('Ended without a pull request | 1');
    expect(md).toContain('Pull request closed unmerged | 1');
    expect(md).toContain('(low sample)');
    expect(md).toContain('Docs draft x');
    expect(md).toContain('Cost per merged PR $21.00');
  });
});
