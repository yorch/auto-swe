import { describe, expect, it } from 'vitest';
import {
  computeAutomationReport,
  computeDeliveryReport,
  computeHitlReport,
  computeQualityReport,
  parseReviewVerdict,
} from './reports.js';

const at = new Date('2026-04-02T00:00:00.000Z');

describe('computeDeliveryReport', () => {
  it('counts PRs separately from runs and reports cohort merge and CI-fix metrics', () => {
    const report = computeDeliveryReport([
      {
        ciFixRounds: 2,
        costUsdAccrued: 4,
        id: 'r1',
        pullRequests: [
          { ciStatus: 'PASSED', mergedAt: new Date(at.getTime() + 1_000) },
          { ciStatus: 'FAILED', mergedAt: null },
        ],
        repoId: 'repo-1',
        repositoryName: 'acme/api',
        startedAt: at,
        status: 'SUCCESS',
        templateId: 't1',
        templateName: 'Build',
        workflowId: 'wf-1',
      },
      {
        ciFixRounds: 9,
        costUsdAccrued: 3,
        id: 'r2',
        pullRequests: [],
        repoId: 'repo-1',
        repositoryName: 'acme/api',
        startedAt: at,
        status: 'FAILED',
        templateId: 't1',
        templateName: 'Build',
        workflowId: 'wf-2',
      },
      {
        ciFixRounds: 0,
        costUsdAccrued: 4,
        id: 'r3',
        pullRequests: [{ ciStatus: 'PENDING', mergedAt: new Date(at.getTime() + 3_000) }],
        repoId: 'repo-2',
        repositoryName: 'acme/web',
        startedAt: at,
        status: 'SUCCESS',
        templateId: 't2',
        templateName: 'Deploy',
        workflowId: 'wf-3',
      },
    ]);

    expect(report).toMatchObject({
      ciFixRounds: { avgPerRun: 1, p95PerRun: 2 },
      costPerMergedPr: 5.5,
      medianTimeToMergeMs: 2_000,
      prsCiPassed: 1,
      prsMerged: 2,
      runsStarted: 3,
      runsSucceeded: 2,
      runsWithPr: 2,
      spendUsd: 11,
      successRate: 2 / 3,
    });
    expect(report.byRepo[0]).toMatchObject({
      repoId: 'repo-1',
      runsStarted: 2,
      spendUsd: 7,
      successRate: 0.5,
    });
    expect(report.byTemplate).toHaveLength(2);
  });
});

describe('computeQualityReport', () => {
  it('counts only completed gates, fix rounds, self-heal runs, and review outcomes', () => {
    const report = computeQualityReport({
      pullRequests: [
        { ciStatus: 'PASSED', mergedAt: null, runId: 'r1' },
        { ciStatus: 'FAILED', mergedAt: at, runId: 'r2' },
      ],
      reviewTraces: [
        {
          outputJson: {
            activityId: 'review-trace-1',
            approved: true,
            findings: [],
            reviewer: 'PERFORMANCE',
            severity: 'PASS',
          },
          runId: 'r1',
        },
        {
          outputJson: {
            approved: false,
            findings: [{ category: 'security' }, { category: 'security' }],
            reviewer: 'SECURITY',
            severity: 'CRITICAL',
          },
          runId: 'r2',
        },
        { outputJson: { activityId: 'failed-call' }, runId: 'r3' },
        { outputJson: { approved: true }, runId: 'r3' },
        {
          error: 'provider failed',
          outputJson: { approved: true, findings: [], reviewer: 'SECURITY', severity: 'PASS' },
          runId: 'r3',
        },
      ],
      runs: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
      steps: [
        { runId: 'r1', status: 'PASSED', stepName: 'runLint' },
        { runId: 'r2', status: 'FAILED', stepName: 'runLint' },
        { runId: 'r2', status: 'PASSED', stepName: 'runLint' },
        { runId: 'r3', status: 'SKIPPED', stepName: 'runLint' },
        { runId: 'r2', status: 'PASSED', stepName: 'runTests' },
        { runId: 'r1', status: 'PASSED', stepName: 'executeCIFixImplementation' },
        { runId: 'r1', status: 'FAILED', stepName: 'executeCIFixImplementation' },
        { runId: 'r2', status: 'PASSED', stepName: 'executeGateFixImplementation' },
      ],
    });

    expect(report.gates.find((gate) => gate.stepName === 'runLint')).toEqual({
      attempts: 3,
      failed: 1,
      finalPassRate: 2 / 3,
      firstAttemptPassRate: 1 / 3,
      passed: 2,
      stepName: 'runLint',
    });
    expect(report.fixLoops.find((loop) => loop.stepName === 'executeCIFixImplementation')).toEqual({
      avgAttemptsPerRun: 2,
      runsWithFix: 1,
      stepName: 'executeCIFixImplementation',
      totalAttempts: 2,
    });
    expect(report.ciSelfHealRate).toBe(1);
    expect(report.review.nonVerdictRows).toBe(1);
    expect(report.review.byReviewer.find((row) => row.reviewer === 'SECURITY')).toMatchObject({
      approvalRate: 0,
      findingsTotal: 2,
      severityCounts: { CRITICAL: 1 },
      topCategories: [{ category: 'security', count: 2 }],
      verdicts: 1,
    });
    expect(report.mergeRateByReviewOutcome).toEqual({
      withoutRejectingVerdict: { mergedRuns: 0, mergeRate: 0, runsWithPr: 1 },
      withRejectingVerdict: { mergedRuns: 1, mergeRate: 1, runsWithPr: 1 },
    });
  });

  it('rejects malformed review trace payloads', () => {
    expect(
      parseReviewVerdict({
        approved: true,
        findings: [{ category: 4 }],
        reviewer: 'SECURITY',
        severity: 'PASS',
      })
    ).toBeNull();
    expect(parseReviewVerdict({ activityId: 'failed-call' })).toBeNull();
    expect(
      parseReviewVerdict({
        activityId: 'real-worker-trace',
        approved: true,
        findings: [{ category: 'maintainability' }],
        reviewer: 'DOMAIN_LOGIC',
        severity: 'INFO',
      })
    ).toMatchObject({ approved: true, reviewer: 'DOMAIN_LOGIC', severity: 'INFO' });
  });

  it('uses grouped step counts while keeping gate rates per run-gate pair', () => {
    const report = computeQualityReport({
      pullRequests: [],
      reviewTraces: [],
      runs: [{ id: 'r1' }, { id: 'r2' }],
      steps: [
        { count: 2, runId: 'r1', status: 'PASSED', stepName: 'runLint' },
        { count: 1, runId: 'r1', status: 'FAILED', stepName: 'runLint' },
        { count: 4, runId: 'r2', status: 'SKIPPED', stepName: 'runLint' },
      ],
    });

    expect(report.gates.find((gate) => gate.stepName === 'runLint')).toEqual({
      attempts: 3,
      failed: 1,
      finalPassRate: 0.5,
      firstAttemptPassRate: 0,
      passed: 2,
      stepName: 'runLint',
    });
  });
});

describe('computeAutomationReport', () => {
  it('marks noisy and broken automations and counts produced successful runs by workflow id', () => {
    const fires = Array.from({ length: 10 }, (_, index) => ({
      automationEnabled: true,
      automationId: 'a1',
      automationName: 'Jira triage',
      createdAt: new Date(at.getTime() + index),
      outcome: index < 3 ? 'STARTED' : 'SUPPRESSED_COOLDOWN',
      reason: index < 3 ? null : 'cooldown',
      temporalWorkflowId: index < 3 ? `wf-${index}` : null,
    }));
    fires.push({
      automationEnabled: false,
      automationId: 'a2',
      automationName: 'Broken source',
      createdAt: at,
      outcome: 'FAILED_TO_START',
      reason: 'provider',
      temporalWorkflowId: null,
    });

    const rows = computeAutomationReport(
      fires,
      new Map([
        ['wf-0', 'FAILED'],
        ['wf-1', 'SUCCESS'],
        ['wf-2', 'FAILED'],
      ])
    );
    expect(rows[0]).toMatchObject({
      broken: false,
      fires: 10,
      noisy: true,
      started: 3,
      successfulProducedRuns: 1,
      suppressed: { cooldown: 7, share: 0.7 },
    });
    expect(rows[1]).toMatchObject({
      automationId: 'a2',
      broken: true,
      failedToStart: 1,
      fires: 1,
    });
    expect(
      computeAutomationReport(
        fires.slice(0, 10).map((fire) => ({
          ...fire,
          outcome: fire.outcome === 'STARTED' ? 'STARTED' : fire.outcome,
        })),
        new Map()
      )[0]?.broken
    ).toBe(true);
  });
});

describe('computeHitlReport', () => {
  it('summarizes resolution waits, current pending work, approvers, and autonomy decisions', () => {
    const request1 = new Date(at.getTime());
    const request2 = new Date(at.getTime() + 1_000);
    const report = computeHitlReport({
      autonomyDecisions: [
        { event: 'approve', riskClass: 'external_communication' },
        { event: 'publish', riskClass: null },
      ],
      now: new Date(at.getTime() + 10_000),
      pendingSteps: [
        {
          kind: 'APPROVAL',
          requestedAt: new Date(at.getTime() - 86_400_000),
          resolvedAt: null,
          resolvedBy: null,
          resolvedByName: null,
          status: 'PENDING',
        },
      ],
      windowSteps: [
        {
          kind: 'APPROVAL',
          requestedAt: request1,
          resolvedAt: new Date(request1.getTime() + 3_600_000),
          resolvedBy: 'u1',
          resolvedByName: 'Ada',
          status: 'RESOLVED',
        },
        {
          kind: 'REVIEW',
          requestedAt: request2,
          resolvedAt: new Date(request2.getTime() + 10_800_000),
          resolvedBy: 'u1',
          resolvedByName: 'Ada',
          status: 'RESOLVED',
        },
        {
          kind: 'DECISION',
          requestedAt: request2,
          resolvedAt: null,
          resolvedBy: null,
          resolvedByName: null,
          status: 'TIMED_OUT',
        },
      ],
    });
    expect(report).toMatchObject({
      autonomy: {
        byEvent: { approve: 1, publish: 1 },
        byRiskClass: { external_communication: 1, unclassified: 1 },
      },
      medianWaitMs: 7_200_000,
      oldestPendingAgeMs: 86_410_000,
      p95WaitMs: 10_800_000,
      pendingNow: 1,
      timedOut: 1,
    });
    expect(report.byApprover).toEqual([
      {
        automated: 0,
        interactive: 0,
        medianWaitMs: 7_200_000,
        name: 'Ada',
        resolved: 2,
      },
    ]);
  });

  it('groups resolution channels and interactive versus automated approver counts', () => {
    const sources = ['web', 'slack', 'api_token', 'mcp', 'assistant', null, 'legacy'];
    const report = computeHitlReport({
      autonomyDecisions: [],
      now: at,
      pendingSteps: [],
      windowSteps: sources.map((resolvedVia) => ({
        kind: 'APPROVAL',
        requestedAt: at,
        resolvedAt: new Date(at.getTime() + 1000),
        resolvedBy: 'user-1',
        resolvedByName: 'Ada',
        resolvedVia,
        status: 'RESOLVED',
      })),
    });

    expect(report.byVia).toEqual({
      api_token: 1,
      assistant: 1,
      mcp: 1,
      slack: 1,
      unknown: 2,
      web: 1,
    });
    expect(report.byApprover).toEqual([
      {
        automated: 3,
        interactive: 2,
        medianWaitMs: 1000,
        name: 'Ada',
        resolved: 7,
      },
    ]);
  });
});
