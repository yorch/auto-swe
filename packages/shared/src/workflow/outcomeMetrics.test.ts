import { describe, expect, it } from 'vitest';
import {
  computeOutcomeReport,
  followUpFromPayload,
  type OutcomePullRequest,
  type OutcomeRun,
  renderOutcomeReportMarkdown,
  runCanOpenPullRequest,
  workItemKeyFor,
} from './outcomeMetrics.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 10);
const window = { end: new Date(T0 + 30 * 24 * H), start: new Date(T0 - 24 * H) };
const generatedAt = new Date(T0 + 40 * 24 * H);

function run(id: string, over: Partial<OutcomeRun> = {}): OutcomeRun {
  return {
    canOpenPullRequest: true,
    costUsd: 1,
    followUpOfRunId: null,
    id,
    isFollowUp: false,
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

describe('CI heal and the test-integrity guard, per repository', () => {
  const runs = [
    // repo-a: two items needed a CI fix; one healed, one was stopped by the guard.
    run('a1', { workItemKey: 'k-a1' }),
    run('a2', { workItemKey: 'k-a2' }),
    // repo-a: an item that never needed a CI fix but was tripped in warn mode.
    run('a3', { workItemKey: 'k-a3' }),
    // repo-b: one item, healed, no trips.
    run('b1', { repoId: 'repo-b', repoName: 'acme/b', workItemKey: 'k-b1' }),
  ];
  const prs = [
    pr('a1', { ciStatus: 'PASSED' }),
    pr('a2', { ciStatus: 'FAILED' }),
    pr('a3', { ciStatus: 'PASSED' }),
    pr('b1', { ciStatus: 'PASSED' }),
  ];
  const steps = ['a1', 'a2', 'b1'].map((runId) => ({
    runId,
    stepName: 'executeCIFixImplementation',
  }));
  const guardTrips = [
    { blocked: true, runId: 'a2' },
    { blocked: true, runId: 'a2' },
    { blocked: false, runId: 'a3' },
  ];
  const report = computeOutcomeReport({
    generatedAt,
    guardTrips,
    pullRequests: prs,
    runs,
    steps,
    window,
  });
  const repo = (id: string) => report.byRepo.find((r) => r.repoId === id);

  it('reports the heal rate and the trips per repository', () => {
    expect(repo('repo-a')?.ciHeal).toMatchObject({
      guard: { blocked: 2, itemsTripped: 2, trips: 3 },
      itemsHealed: 1,
      itemsWithCiFix: 2,
      rate: 0.5,
    });
    expect(repo('repo-b')?.ciHeal).toMatchObject({
      guard: { blocked: 0, itemsTripped: 0, trips: 0 },
      itemsHealed: 1,
      itemsWithCiFix: 1,
      rate: 1,
    });
  });

  it('sums the trips overall and counts them as an input', () => {
    expect(report.overall.ciHeal.guard).toEqual({ blocked: 2, itemsTripped: 2, trips: 3 });
    expect(report.inputs.guardTrips).toBe(3);
  });

  it('reads as zero trips when the caller supplied none', () => {
    const none = computeOutcomeReport({ generatedAt, pullRequests: prs, runs, steps, window });
    expect(none.overall.ciHeal.guard).toEqual({ blocked: 0, itemsTripped: 0, trips: 0 });
    expect(none.inputs.guardTrips).toBe(0);
  });

  it('renders a snapshot stored before the guard existed as no trips', () => {
    const legacy = JSON.parse(JSON.stringify(report));
    for (const group of [legacy.overall, ...legacy.byRepo, ...legacy.byTemplate]) {
      group.ciHeal.guard = undefined;
    }
    legacy.inputs.guardTrips = undefined;
    const md = renderOutcomeReportMarkdown(legacy);
    expect(md).toContain('test-integrity guard trips: 0');
    expect(md).toContain('| acme/a (low sample) | 2 | 1 | 50.0% (9-91%) | 0 | 0 | 0 |');
  });

  it('renders a CI-healing table per repository beside the trips', () => {
    const md = renderOutcomeReportMarkdown(report);
    expect(md).toContain('## CI healing by repository');
    expect(md).toContain('| acme/a (low sample) | 2 | 1 | 50.0% (9-91%) | 3 | 2 | 2 |');
    expect(md).toContain('| acme/b (low sample) | 1 | 1 | 100.0%');
    expect(md).toContain('the test-integrity guard tripped 3 time(s) on 2 item(s), 2 blocked');
  });
});

describe('work that cannot open a pull request', () => {
  const runs = [
    run('m1', { workItemKey: 'k-m' }),
    run('x1', { workItemKey: 'k-x' }),
    // A Slack-style template: succeeded, never had a pull request to produce.
    run('s1', {
      canOpenPullRequest: false,
      costUsd: 4,
      repoId: null,
      templateId: 'ts',
      templateName: 'Slack',
      workItemKey: 'k-s1',
    }),
    run('s2', {
      canOpenPullRequest: false,
      costUsd: 6,
      repoId: null,
      templateId: 'ts',
      templateName: 'Slack',
      workItemKey: 'k-s2',
    }),
  ];
  const prs = [pr('m1', { mergedAt: new Date(T0 + H), status: 'MERGED' })];
  const report = computeOutcomeReport({ generatedAt, pullRequests: prs, runs, steps: [], window });
  const o = report.overall;

  it('keeps it out of the denominators and the unmerged spend', () => {
    expect(o.workItems).toBe(4);
    expect(o.prWorkItems).toBe(2);
    expect(o.states).toEqual({ closed_unmerged: 0, merged: 1, no_pr: 1, open: 0, running: 0 });
    expect(o.settledItems).toBe(2);
    expect(o.mergeRate).toBe(0.5);
    expect(o.cost.unmergedSettledUsd).toBe(1);
  });

  it('reports it on its own and leaves it out of cost per merged PR', () => {
    expect(o.noPrWork).toEqual({ costUsd: 10, items: 2, runs: 2 });
    expect(o.cost.totalUsd).toBe(12);
    expect(o.cost.perMergedPr).toBe(2);
    expect(report.byTemplate.find((t) => t.templateName === 'Slack')).toMatchObject({
      mergeRate: null,
      prWorkItems: 0,
      settledItems: 0,
    });
    const md = renderOutcomeReportMarkdown(report);
    expect(md).toContain('## Work outside the merge rate');
    expect(md).toContain('| No run could open a pull request | 2 | 2 | $10.00 |');
  });

  it('still counts it as merge-rate work when a pull request exists', () => {
    const withPr = computeOutcomeReport({
      generatedAt,
      pullRequests: [pr('s1')],
      runs: [runs[2] as OutcomeRun],
      steps: [],
      window,
    });
    expect(withPr.overall.prWorkItems).toBe(1);
    expect(withPr.overall.noPrWork.items).toBe(0);
  });
});

describe('follow-up runs', () => {
  const origin = run('o1', { costUsd: 5, workItemKey: 'k-o' });
  const fix = run('f1', {
    costUsd: 2,
    followUpOfRunId: 'o1',
    isFollowUp: true,
    startedAt: new Date(T0 + 2 * H),
    templateId: 'tf',
    templateName: 'Address PR feedback',
    workItemKey: 'request:f1',
  });
  const steps = [
    { runId: 'f1', stepName: 'executeReviewFixImplementation' },
    { runId: 'f1', stepName: 'executeReviewFixImplementation' },
  ];

  it('joins the item of the run it acts on, with its cost and review rounds', () => {
    const report = computeOutcomeReport({
      generatedAt,
      pullRequests: [pr('o1', { mergedAt: new Date(T0 + 9 * H), status: 'MERGED' })],
      runs: [origin, fix],
      steps,
      window,
    });
    const o = report.overall;
    expect(o.workItems).toBe(1);
    expect(o.states.merged).toBe(1);
    expect(o.states.no_pr).toBe(0);
    expect(o.cost.mergedItemsUsd).toBe(7);
    expect(o.reviewRounds).toMatchObject({ itemsWithAnyRound: 1, itemsWithPr: 1, max: 2 });
    expect(o.unlinkedFollowUps.items).toBe(0);
  });

  it('follows a chain of follow-ups and attributes an unmerged item to the original run', () => {
    const second = run('f2', {
      followUpOfRunId: 'f1',
      isFollowUp: true,
      startedAt: new Date(T0 + 3 * H),
      templateId: 'tf',
      templateName: 'Address PR feedback',
      workItemKey: 'request:f2',
    });
    const report = computeOutcomeReport({
      generatedAt,
      pullRequests: [pr('o1', { status: 'OPEN' })],
      runs: [origin, fix, second],
      steps: [],
      window,
    });
    expect(report.overall.workItems).toBe(1);
    expect(report.overall.states.open).toBe(1);
    expect(report.byTemplate.map((t) => t.templateName)).toEqual(['Engineering']);
  });

  it('keeps a follow-up with no originating run on its own, outside every rate', () => {
    const orphan = run('f9', {
      canOpenPullRequest: false,
      costUsd: 3,
      followUpOfRunId: 'gone',
      isFollowUp: true,
      status: 'FAILED',
      workItemKey: 'request:f9',
    });
    const report = computeOutcomeReport({
      generatedAt,
      pullRequests: [],
      runs: [orphan],
      steps: [],
      window,
    });
    const o = report.overall;
    expect(o.unlinkedFollowUps).toEqual({ costUsd: 3, items: 1, runs: 1 });
    expect(o.states.no_pr).toBe(0);
    expect(o.settledItems).toBe(0);
    expect(o.cost.unmergedSettledUsd).toBe(0);
    expect(o.cost.totalUsd).toBe(3);
  });
});

describe('followUpFromPayload', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('reads the originating run from a stored review fix', () => {
    expect(followUpFromPayload({ deliver: 'none', reviewFixOfRunId: id })).toEqual({
      followUpOfRunId: id,
      isFollowUp: true,
    });
  });
  it('reads it from PR feedback started by review findings, not from a GitHub event id', () => {
    const base = { feedbackEventId: id, feedbackTrigger: 'review_findings', pullRequestNumber: 4 };
    expect(followUpFromPayload(base)).toEqual({ followUpOfRunId: id, isFollowUp: true });
    expect(
      followUpFromPayload({ ...base, feedbackEventId: '777', feedbackTrigger: 'changes_requested' })
    ).toEqual({ followUpOfRunId: null, isFollowUp: true });
  });
  it('treats anything else as not a follow-up', () => {
    expect(followUpFromPayload(null)).toEqual({ followUpOfRunId: null, isFollowUp: false });
    expect(followUpFromPayload({ deliver: 'none' })).toEqual({
      followUpOfRunId: null,
      isFollowUp: false,
    });
  });
});

describe('runCanOpenPullRequest', () => {
  it('finds a pull-request step in the spec', () => {
    expect(runCanOpenPullRequest({ nodes: [{ step: 'createOrUpdatePullRequest' }] }, null)).toBe(
      true
    );
    expect(runCanOpenPullRequest({ nodes: [{ step: 'postSlackMessage' }] }, null)).toBe(false);
  });
  it('lets an agent run through only when it asked for a draft PR', () => {
    const spec = { nodes: [{ step: 'runAgentTask' }] };
    expect(runCanOpenPullRequest(spec, { deliver: 'draft_pr' })).toBe(true);
    expect(runCanOpenPullRequest(spec, { deliver: 'none' })).toBe(false);
  });
  it('counts a missing spec as capable', () => {
    expect(runCanOpenPullRequest(undefined, null)).toBe(true);
  });
});
