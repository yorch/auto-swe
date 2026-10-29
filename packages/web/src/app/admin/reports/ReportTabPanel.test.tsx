// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type ReportTab, type ReportTabData, ReportTabPanel } from './ReportTabPanel';

const cases: Array<{
  empty: ReportTabData;
  expected: string;
  populated: ReportTabData;
  tab: ReportTab;
}> = [
  {
    empty: {
      byRepo: [],
      byTemplate: [],
      costPerMergedPr: null,
      medianTimeToMergeMs: null,
      prsCiPassed: 0,
      prsMerged: 0,
      runsStarted: 0,
      runsSucceeded: 0,
      runsWithPr: 0,
    },
    expected: 'By template',
    populated: {
      byRepo: [],
      byTemplate: [{ runsStarted: 2, templateId: 't1', templateName: 'Ticket to PR' }],
      costPerMergedPr: 4,
      medianTimeToMergeMs: 3_600_000,
      prsCiPassed: 1,
      prsMerged: 1,
      runsStarted: 2,
      runsSucceeded: 1,
      runsWithPr: 1,
    },
    tab: 'delivery',
  },
  {
    empty: {
      ciSelfHealRate: null,
      fixLoops: [],
      gates: [],
      review: { byReviewer: [], unparseableRows: 0 },
    },
    expected: 'Quality gates',
    populated: {
      ciSelfHealRate: 0.5,
      fixLoops: [],
      gates: [{ failed: 1, passed: 1, passRate: 0.5, stepName: 'runLint', total: 2 }],
      review: { byReviewer: [], unparseableRows: 0 },
    },
    tab: 'quality',
  },
  {
    empty: { organizations: [] },
    expected: 'Example Org: $50.00 MTD · $75.00 projected · ok',
    populated: {
      organizations: [
        {
          lowConfidence: false,
          mtdUsd: 50,
          name: 'Example Org',
          orgId: 'org-1',
          projectedUsd: 75,
          status: 'ok',
          topRuns: [],
        },
      ],
    },
    tab: 'budget',
  },
  {
    empty: { automations: [] },
    expected: 'Jira triage: 2 fires · 1 started · 1 suppressed (50.0%)',
    populated: {
      automations: [
        {
          automationId: 'a1',
          automationName: 'Jira triage',
          broken: false,
          fires: 2,
          noisy: false,
          started: 1,
          suppressed: { share: 0.5, total: 1 },
        },
      ],
    },
    tab: 'automations',
  },
  {
    empty: {
      autonomy: { byEvent: {}, byRiskClass: {} },
      byApprover: [],
      medianWaitMs: null,
      oldestPendingAgeMs: null,
      pendingNow: 0,
      timedOut: 0,
    },
    expected: 'By approver',
    populated: {
      autonomy: { byEvent: { approve: 1 }, byRiskClass: { low: 1 } },
      byApprover: [{ medianWaitMs: 3_600_000, name: 'Ada', resolved: 1 }],
      medianWaitMs: 3_600_000,
      oldestPendingAgeMs: 86_400_000,
      pendingNow: 1,
      timedOut: 0,
    },
    tab: 'hitl',
  },
];

describe.each(cases)('$tab report tab', ({ empty, expected, populated, tab }) => {
  it('renders the empty state', () => {
    render(<ReportTabPanel data={empty} tab={tab} />);
    expect(screen.getByText(/No .*data|No .*activity/)).toBeTruthy();
  });

  it('renders populated report data', () => {
    render(<ReportTabPanel data={populated} tab={tab} />);
    expect(screen.getByText(expected)).toBeTruthy();
  });
});
