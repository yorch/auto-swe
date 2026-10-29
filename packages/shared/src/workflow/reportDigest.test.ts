import { describe, expect, it } from 'vitest';
import { buildReportDigest } from './reportDigest.js';
import { buildWorkflowRunDailyRollups } from './workflowRunRollup.js';

const now = new Date('2026-10-20T12:00:00Z');
const currentPeriod = {
  end: new Date('2026-10-19T23:59:59Z'),
  start: new Date('2026-10-13T00:00:00Z'),
};
const previousPeriod = {
  end: new Date('2026-10-12T23:59:59Z'),
  start: new Date('2026-10-06T00:00:00Z'),
};

function rows(input: {
  cost: number;
  id: string;
  merged: boolean;
  startedAt: Date;
  status: string;
}) {
  return buildWorkflowRunDailyRollups({
    now,
    pullRequests: input.merged
      ? [
          {
            ciStatus: 'PASSED',
            mergedAt: new Date(input.startedAt.getTime() + 60 * 60 * 1000),
            runId: input.id,
            status: 'MERGED',
          },
        ]
      : [],
    runs: [
      {
        attributedOrgId: 'org',
        attributedTeamId: 'team',
        costUsdAccrued: input.cost,
        endedAt: new Date(input.startedAt.getTime() + 60 * 60 * 1000),
        estimatedHumanTimeSaved: 60,
        hadHumanStep: false,
        id: input.id,
        outcomeDomain: null,
        outcomeType: null,
        repoId: null,
        startedAt: input.startedAt,
        status: input.status,
        templateId: 'hostile-template',
        templateVersion: 1,
        wasAutonomous: true,
      },
    ],
    steps: [],
    traces: [],
  });
}

describe('buildReportDigest', () => {
  it('renders metrics, prior-week deltas, gate, approval age, and organization budget', () => {
    const currentRows = rows({
      cost: 6,
      id: 'current',
      merged: true,
      startedAt: new Date('2026-10-15T12:00:00Z'),
      status: 'SUCCESS',
    });
    const previousRows = rows({
      cost: 4,
      id: 'previous',
      merged: false,
      startedAt: new Date('2026-10-08T12:00:00Z'),
      status: 'FAILED',
    });
    const digest = buildReportDigest({
      budget: { mtdUsd: 20, projectedUsd: 40, status: 'within_budget' },
      currentPeriod,
      currentRows,
      now,
      oldestPendingApprovalRequestedAt: new Date('2026-10-20T10:00:00Z'),
      pendingApprovalCount: 1,
      previousPeriod,
      previousRows,
      reportsUrl: 'https://example.test/admin/reports',
      scope: { name: 'Payments', type: 'ORGANIZATION' },
      templateNames: new Map([['hostile-template', 'Review template']]),
      worstGate: { finalPassRate: 0.8, name: 'securityReview', pairs: 10 },
    });
    expect(digest.subject).toContain('Payments weekly report');
    expect(digest.text).toContain('Runs: 1 (0)');
    expect(digest.text).toContain('Success rate: 100.0% (+100.0 pp)');
    expect(digest.text).toContain('PRs merged: 1 (+1)');
    expect(digest.text).toContain('Cost per merged PR: $6.00');
    expect(digest.text).toContain('Spend: $6.00 (+2)');
    expect(digest.text).toContain('Estimated time saved: 60 min (+60)');
    expect(digest.text).toContain('Review template: 1 runs, 100.0% success, 100.0% merge');
    expect(digest.text).toContain('Worst gate: securityReview (80.0% final pass rate)');
    expect(digest.text).toContain('Pending approvals: 1; oldest 2.0 hours');
    expect(digest.text).toContain('Month-to-date spend: $20.00');
    expect(digest.text).toContain('Projected monthly spend: $40.00');
    expect(digest.html).toContain('https://example.test/admin/reports');
    const htmlTags = [...digest.html.matchAll(/<\/?([a-z][a-z0-9]*)\b/gi)].map((match) =>
      (match[1] ?? '').toLowerCase()
    );
    expect(htmlTags.every((tag) => ['a', 'table', 'th', 'tr', 'td'].includes(tag))).toBe(true);
    expect(digest.html).toContain('style="');
    expect(digest.html).not.toMatch(/<style\b|class=/i);
    expect(digest.html).toContain('color:#18794e');
    expect(digest.html).toContain('color:#b42318');
    const blockTypes = digest.slackBlocks.map((block) => (block as { type: string }).type);
    expect(blockTypes).toEqual(['header', 'section', 'section', 'context', 'actions']);
    expect(digest.slackMrkdwn).toContain('Open reports: https://example.test/admin/reports');
  });

  it('handles an empty week without inventing rates or deltas', () => {
    const digest = buildReportDigest({
      currentPeriod,
      currentRows: [],
      now,
      oldestPendingApprovalRequestedAt: null,
      pendingApprovalCount: 0,
      previousPeriod,
      previousRows: [],
      scope: { name: 'Platform', type: 'TEAM' },
    });
    expect(digest.text).toContain('Runs: 0 (0)');
    expect(digest.text).toContain('Success rate: n/a (n/a)');
    expect(digest.text).toContain('Cost per merged PR: n/a (n/a)');
    expect(digest.text).toContain('- No template runs');
    expect(digest.text).toContain('Pending approvals: 0');
  });

  it('escapes hostile template names in Slack and HTML', () => {
    const hostile = '<img src=x onerror="x"> *alert*';
    const digest = buildReportDigest({
      currentPeriod,
      currentRows: rows({
        cost: 1,
        id: 'current',
        merged: false,
        startedAt: new Date('2026-10-15T12:00:00Z'),
        status: 'SUCCESS',
      }),
      now,
      oldestPendingApprovalRequestedAt: null,
      pendingApprovalCount: 0,
      previousPeriod,
      previousRows: [],
      scope: { name: 'Team', type: 'TEAM' },
      templateNames: new Map([['hostile-template', hostile]]),
    });
    expect(digest.html).not.toContain('<img');
    expect(digest.html).toContain('&lt;img');
    expect(digest.slackMrkdwn).toContain('&lt;img');
    expect(digest.slackMrkdwn).toContain('\\*alert\\*');
  });

  it('strips line breaks from scope headings and escapes them in every format', () => {
    const digest = buildReportDigest({
      currentPeriod,
      currentRows: [],
      now,
      oldestPendingApprovalRequestedAt: null,
      pendingApprovalCount: 0,
      previousPeriod,
      previousRows: [],
      scope: { name: 'Org\r\n<script>&', type: 'ORGANIZATION' },
    });
    expect(digest.subject).not.toMatch(/[\r\n]/);
    expect(digest.subject).toContain('Org <script>&');
    expect(digest.html).not.toContain('<script>');
    expect(digest.html).toContain('&lt;script&gt;&amp;');
    expect(digest.slackMrkdwn).not.toMatch(/Org\r\n/);
  });

  it('labels capped gate reads as not computed', () => {
    const digest = buildReportDigest({
      currentPeriod,
      currentRows: [],
      now,
      oldestPendingApprovalRequestedAt: null,
      pendingApprovalCount: 0,
      previousPeriod,
      previousRows: [],
      scope: { name: 'Team', type: 'TEAM' },
      worstGateNotComputed: true,
    });
    expect(digest.text).toContain('Worst gate: not computed');
  });
});
