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
    workflowId: `wf-${id}`,
    workRequest: { externalTicketId: 'PAY-1', id: `req-${id}`, ticketIsSynthetic: false },
    ...over,
  };
}

function fakeDb(runs: unknown[]) {
  return {
    activeWorkflow: {
      findMany: vi.fn().mockResolvedValue([{ costUsdAccrued: 7, temporalWorkflowId: 'wf-r2' }]),
    },
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

  it('reads runs from the lookback before the window so older work is not recounted', async () => {
    const db = fakeDb([]);
    await buildOutcomeReport(db as unknown as OutcomeReportDb, { now: NOW });
    const where = db.workflowRun.findMany.mock.calls[0]?.[0].where.startedAt.gte as Date;
    // Window starts 2025-12-10; the lookback reaches 30 days earlier.
    expect(where.toISOString()).toBe('2025-11-10T00:00:00.000Z');
  });
});
