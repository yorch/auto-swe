import { describe, expect, it, vi } from 'vitest';
import { buildOutcomeReport, type OutcomeReportDb, trailingWindow } from './outcomeReport.js';

const NOW = new Date('2026-03-10T15:30:00Z');

describe('trailingWindow', () => {
  it('ends at the start of the current UTC day so reruns within a day agree', () => {
    const a = trailingWindow(NOW, 90);
    const b = trailingWindow(new Date('2026-03-10T01:00:00Z'), 90);
    expect(a).toEqual(b);
    expect(a.end.toISOString()).toBe('2026-03-10T00:00:00.000Z');
    expect(a.start.toISOString()).toBe('2025-12-10T00:00:00.000Z');
  });
});

function run(id: string, over: Record<string, unknown> = {}) {
  return {
    attributedRepoId: 'repo-1',
    costUsdAccrued: 2,
    id,
    startedAt: new Date('2026-03-01T00:00:00Z'),
    status: 'SUCCESS',
    template: { name: 'Engineering' },
    templateId: 't1',
    templateVersion: 1,
    workflowId: `wf-${id}`,
    workRequest: {
      externalTicketId: 'PAY-1',
      id: `req-${id}`,
      payload: null,
      ticketIsSynthetic: false,
    },
    ...over,
  };
}

function fakeDb(runs: unknown[], traces: unknown[] = []) {
  return {
    activeWorkflow: {
      findMany: vi.fn().mockResolvedValue([{ costUsdAccrued: 7, temporalWorkflowId: 'wf-r2' }]),
    },
    agentTrace: { findMany: vi.fn().mockResolvedValue(traces) },
    connection: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: 'repo-1', organizationName: 'acme', repoName: 'api' }]),
    },
    pullRequest: {
      findMany: vi.fn().mockResolvedValue([
        {
          ciStatus: 'PASSED',
          mergedAt: new Date('2026-03-02T00:00:00Z'),
          runId: 'r2',
          status: 'MERGED',
        },
      ]),
    },
    workflowRun: { findMany: vi.fn().mockResolvedValue(runs) },
    workflowStep: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ runId: 'r1', stepName: 'executeReviewFixImplementation' }]),
    },
    workflowTemplateVersion: {
      findMany: vi.fn().mockResolvedValue([
        {
          spec: { nodes: [{ step: 'createOrUpdatePullRequest' }] },
          templateId: 't1',
          version: 1,
        },
        { spec: { nodes: [{ step: 'postSlackMessage' }] }, templateId: 't-slack', version: 1 },
      ]),
    },
  };
}

describe('buildOutcomeReport', () => {
  it('folds a retried ticket into one item and falls back to the ledger cost', async () => {
    const db = fakeDb([
      run('r1', { costUsdAccrued: 3, status: 'FAILED' }),
      // No cost on the run row: the ActiveWorkflow ledger supplies it.
      run('r2', { costUsdAccrued: 0, startedAt: new Date('2026-03-01T06:00:00Z') }),
    ]);
    const report = await buildOutcomeReport(db as unknown as OutcomeReportDb, { now: NOW });
    expect(report.overall.workItems).toBe(1);
    expect(report.overall.runs).toBe(2);
    expect(report.overall.cost.totalUsd).toBe(10);
    expect(report.overall.cost.perMergedPr).toBe(10);
    expect(report.overall.reviewRounds.itemsWithAnyRound).toBe(1);
    expect(report.byRepo[0]?.repoName).toBe('acme/api');
    expect(report.inputs.truncated).toBe(false);
  });

  it('counts test-integrity guard trips by run and ignores a gate that degraded', async () => {
    const db = fakeDb(
      [
        run('r1', { costUsdAccrued: 3, status: 'FAILED' }),
        run('r2', { costUsdAccrued: 1, startedAt: new Date('2026-03-01T06:00:00Z') }),
      ],
      [
        { outputJson: { blocked: true, mode: 'block' }, runId: 'r1' },
        { outputJson: { blocked: false, mode: 'warn' }, runId: 'r2' },
        { outputJson: { blocked: true, degraded: true, mode: 'block' }, runId: 'r2' },
        { outputJson: null, runId: null },
      ]
    );
    const report = await buildOutcomeReport(db as unknown as OutcomeReportDb, { now: NOW });
    expect(db.agentTrace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          toolName: 'ci_fix.test_integrity_guard',
          type: 'activity_event',
        }),
      })
    );
    expect(report.overall.ciHeal.guard).toEqual({ blocked: 1, itemsTripped: 1, trips: 2 });
    expect(report.inputs.guardTrips).toBe(2);
  });

  it('counts a trip once per workflow attempt at a node, however many events it left', async () => {
    const db = fakeDb(
      [run('r1', { costUsdAccrued: 3, status: 'FAILED' })],
      [
        // Temporal retried the same dispatch: one attempt, one trip, blocked once any blocked.
        { outputJson: { blocked: false }, recordingId: 'ciFix', runId: 'r1', stepAttempt: 1 },
        { outputJson: { blocked: true }, recordingId: 'ciFix', runId: 'r1', stepAttempt: 1 },
        // A second workflow attempt is a second trip.
        { outputJson: { blocked: false }, recordingId: 'ciFix', runId: 'r1', stepAttempt: 2 },
      ]
    );
    const report = await buildOutcomeReport(db as unknown as OutcomeReportDb, { now: NOW });
    expect(report.overall.ciHeal.guard).toEqual({ blocked: 1, itemsTripped: 1, trips: 2 });
  });

  it('reads runs from the lookback before the window so older work is not recounted', async () => {
    const db = fakeDb([]);
    await buildOutcomeReport(db as unknown as OutcomeReportDb, { now: NOW });
    const where = db.workflowRun.findMany.mock.calls[0]?.[0].where.startedAt.gte as Date;
    // Window starts 2025-12-10; the lookback reaches 30 days earlier.
    expect(where.toISOString()).toBe('2025-11-10T00:00:00.000Z');
  });

  it('joins a review-fix follow-up to its origin and sets aside a no-PR template', async () => {
    const origin = '11111111-1111-4111-8111-111111111111';
    const db = fakeDb([
      run(origin, { costUsdAccrued: 2 }),
      run('r2', {
        costUsdAccrued: 1,
        startedAt: new Date('2026-03-01T03:00:00Z'),
        workRequest: {
          externalTicketId: 'agent-run-x',
          id: 'req-fix',
          payload: {
            feedbackEventId: origin,
            feedbackTrigger: 'review_findings',
            pullRequestNumber: 3,
          },
          ticketIsSynthetic: true,
        },
      }),
      run('r3', {
        attributedRepoId: null,
        costUsdAccrued: 5,
        template: { name: 'Slack' },
        templateId: 't-slack',
        workRequest: null,
      }),
    ]);
    db.pullRequest.findMany.mockResolvedValue([
      {
        ciStatus: 'PASSED',
        mergedAt: new Date('2026-03-02T00:00:00Z'),
        runId: origin,
        status: 'MERGED',
      },
    ]);
    const report = await buildOutcomeReport(db as unknown as OutcomeReportDb, { now: NOW });
    const o = report.overall;
    expect(o.prWorkItems).toBe(1);
    expect(o.states.merged).toBe(1);
    expect(o.states.no_pr).toBe(0);
    expect(o.cost.mergedItemsUsd).toBe(3);
    expect(o.noPrWork).toEqual({ costUsd: 5, items: 1, runs: 1 });
    expect(o.unlinkedFollowUps.items).toBe(0);
  });
});
