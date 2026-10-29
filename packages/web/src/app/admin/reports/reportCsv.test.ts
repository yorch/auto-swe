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
      byApprover: [{ medianWaitMs: 100, name: 'Reviewer', resolved: 1 }],
      byKind: { PR: { RESOLVED: 1 } },
      medianWaitMs: 100,
      oldestPendingAgeMs: null,
      p95WaitMs: 100,
      pendingNow: 0,
      timedOut: 0,
    });

    for (const section of ['gates', 'fixLoops', 'reviewers', 'mergeByReviewOutcome']) {
      expect(quality).toContain(`"${section}"`);
    }
    for (const section of ['summary', 'byKind', 'approvers', 'autonomyByEvent', 'autonomyByRisk']) {
      expect(approvals).toContain(`"${section}"`);
    }
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
