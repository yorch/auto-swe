import { describe, expect, it } from 'vitest';
import type { ReportTabData } from './ReportTabPanel';
import { reportCsv } from './reportCsv';

describe('reportCsv', () => {
  it('neutralizes spreadsheet formulas in cells', () => {
    const csv = reportCsv('budget', {
      organizations: [
        {
          lowConfidence: false,
          mtdUsd: 10,
          name: '=SUM(1,2)',
          orgId: 'org-1',
          projectedUsd: 12,
          status: 'watch',
          topRuns: [],
        },
      ],
    } satisfies ReportTabData);

    expect(csv).toContain(`"'=SUM(1,2)"`);
  });

  it('writes nested values as JSON instead of [object Object]', () => {
    const csv = reportCsv('automations', {
      automations: [{ id: 'a-1', outcomes: { STARTED: 2 }, tags: ['x', 'y'] }],
    } as unknown as ReportTabData);

    expect(csv).not.toContain('[object Object]');
    expect(csv).toContain('"{""STARTED"":2}"');
    expect(csv).toContain('"[""x"",""y""]"');
  });

  it('leaves numbers, including negative ones, unprefixed', () => {
    const csv = reportCsv('automations', {
      automations: [{ delta: -1, id: 'a-1', note: '-1' }],
    } as unknown as ReportTabData);

    expect(csv).toContain('"-1","a-1"');
    expect(csv).toContain(`"'-1"`);
  });

  it('exports every quality and approval section with section labels', () => {
    const quality = reportCsv('quality', {
      ciSelfHealRate: null,
      fixLoops: [{ avgAttemptsPerRun: 1, runsWithFix: 1, stepName: 'fix', totalAttempts: 1 }],
      gates: [
        {
          attempts: 1,
          failed: 0,
          finalPassRate: 1,
          firstAttemptPassRate: 1,
          passed: 1,
          stepName: 'runTests',
        },
      ],
      mergeRateByReviewOutcome: {
        withoutRejectingVerdict: { mergedRuns: 1, mergeRate: 1, runsWithPr: 1 },
        withRejectingVerdict: { mergedRuns: 0, mergeRate: 0, runsWithPr: 1 },
      },
      review: {
        byReviewer: [{ approvalRate: 1, findingsTotal: 0, reviewer: 'SECURITY', verdicts: 1 }],
        nonVerdictRows: 0,
      },
    });
    const approvals = reportCsv('hitl', {
      autonomy: { byEvent: { allowed: 1 }, byRiskClass: { low: 1 } },
      byApprover: [
        { automated: 0, interactive: 1, medianWaitMs: 100, name: 'Reviewer', resolved: 1 },
      ],
      byKind: { PR: { RESOLVED: 1 } },
      byVia: { api_token: 0, assistant: 0, mcp: 0, slack: 0, unknown: 0, web: 1 },
      medianWaitMs: 100,
      oldestPendingAgeMs: null,
      p95WaitMs: 100,
      pendingNow: 0,
      timedOut: 0,
    });

    for (const section of ['gates', 'fixLoops', 'reviewers', 'mergeByReviewOutcome']) {
      expect(quality).toContain(`"${section}"`);
    }
    for (const section of [
      'summary',
      'byKind',
      'approvers',
      'byVia',
      'autonomyByEvent',
      'autonomyByRisk',
    ]) {
      expect(approvals).toContain(`"${section}"`);
    }
    expect(approvals).toContain('"interactive"');
    expect(approvals).toContain('"automated"');
  });

  it('exports the delivery by-team table', () => {
    const csv = reportCsv('delivery', {
      byRepo: [],
      byTeam: [{ runsStarted: 2, spendUsd: 3, teamId: 'team-1', teamName: 'Payments' }],
      byTemplate: [],
      costPerMergedPr: null,
      medianTimeToMergeMs: null,
      prsCiPassed: 0,
      prsMerged: 0,
      runsStarted: 2,
      runsSucceeded: 1,
      runsWithPr: 0,
      spendUsd: 3,
    });
    expect(csv).toContain('"byTeam"');
    expect(csv).toContain('"Payments"');
  });

  it('exports budget organizations and their top runs as separate sections', () => {
    const csv = reportCsv('budget', {
      organizations: [
        {
          lowConfidence: false,
          mtdUsd: 10,
          name: 'Example Org',
          orgId: 'org-1',
          projectedUsd: 12,
          status: 'ok',
          topRuns: [{ costUsd: 5, id: 'run-1', workflowId: 'workflow-1' }],
        },
      ],
    });

    expect(csv).toContain('"organizations"');
    expect(csv).toContain('"topRuns"');
    expect(csv).toContain('"workflow-1"');
  });
});
