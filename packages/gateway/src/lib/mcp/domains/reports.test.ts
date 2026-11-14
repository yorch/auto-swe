import { forecastMonthlyBudget } from '@auto-swe/shared/lib/budgetForecast';
import {
  buildWorkflowRunDailyRollups,
  computeAutomationReport,
  computeHitlReport,
  computeQualityReport,
  deliveryReportFromRollups,
  workflowRunRollupInputFromRun,
} from '@auto-swe/shared/workflow';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMcpTestApp, INJECTION, type StubRoutes } from '../../../test/mcpHarness.js';

const REPO = '22222222-2222-4222-8222-222222222222';
const TEAM = '33333333-3333-4333-8333-333333333333';
const TEMPLATE = '44444444-4444-4444-8444-444444444444';
const ORG = '55555555-5555-4555-8555-555555555555';
const RUN = '66666666-6666-4666-8666-666666666666';
const AUTOMATION = '77777777-7777-4777-8777-777777777777';

const window = { windowEnd: '2026-11-14T00:00:00.000Z', windowStart: '2026-10-15T00:00:00.000Z' };

const metrics = (over: Record<string, unknown> = {}) => ({
  ciFixRounds: { avgPerRun: 1.5, p95PerRun: 3 },
  costPerMergedPr: 4.2,
  medianTimeToMergeMs: 3_600_000,
  prsCiPassed: 8,
  prsMerged: 6,
  runsStarted: 10,
  runsSucceeded: 7,
  runsWithPr: 9,
  spendUsd: 25.2,
  successRate: 0.7,
  ...over,
});

const delivery = () => ({
  data: {
    ...metrics(),
    byRepo: [{ ...metrics(), repoId: REPO, repositoryName: `acme/api ${INJECTION}`.repeat(10) }],
    byTeam: [{ ...metrics(), teamId: TEAM, teamName: 'Payments' }],
    byTemplate: [{ ...metrics(), templateId: TEMPLATE, templateName: 'Fix a ticket' }],
    ciFixStepsTruncated: false,
    liveDays: 1,
    prsTruncated: false,
    rollupDays: 29,
    runsTruncated: false,
    truncated: false,
    ...window,
  },
});

const quality = () => ({
  data: {
    ciSelfHealRate: 0.5,
    fixLoops: [
      {
        avgAttemptsPerRun: 1.2,
        runsWithFix: 4,
        stepName: 'executeCIFixImplementation',
        totalAttempts: 5,
      },
    ],
    gates: [
      {
        attempts: 10,
        failed: 2,
        finalPassRate: 0.9,
        firstAttemptPassRate: 0.8,
        passed: 8,
        stepName: 'runLint',
      },
    ],
    mergeRateByReviewOutcome: {
      withoutRejectingVerdict: { mergedRuns: 8, mergeRate: 0.8, runsWithPr: 10 },
      withRejectingVerdict: { mergedRuns: 1, mergeRate: 0.2, runsWithPr: 5 },
    },
    metricPrsTruncated: false,
    review: {
      byReviewer: [
        {
          approvalRate: 0.75,
          approved: 3,
          findingsTotal: 2,
          reviewer: 'SECURITY',
          severityCounts: { CRITICAL: 0, INFO: 1, PASS: 3, WARNING: 1 },
          topCategories: [{ category: INJECTION, count: 2 }],
          verdicts: 4,
        },
      ],
      nonVerdictRows: 1,
    },
    truncated: true,
    ...window,
  },
});

const hitl = () => ({
  data: {
    autonomy: { byEvent: { approve: 2, [INJECTION]: 9 }, byRiskClass: { LOW: 2 } },
    byApprover: [
      { automated: 0, interactive: 3, medianWaitMs: 1000, name: INJECTION, resolved: 3 },
    ],
    byKind: { APPROVAL: { PENDING: 1, RESOLVED: 3 } },
    byVia: { web: 3 },
    medianWaitMs: 1000,
    oldestPendingAgeMs: 5000,
    p95WaitMs: 2000,
    pendingNow: 1,
    timedOut: 0,
    truncated: false,
    ...window,
  },
});

const automations = () => ({
  data: {
    automations: [
      {
        automationEnabled: true,
        automationId: AUTOMATION,
        automationName: `Nightly ${INJECTION}`.repeat(20),
        broken: false,
        failedToStart: 0,
        fires: 5,
        lastFiredAt: '2026-11-13T00:00:00.000Z',
        noisy: false,
        outcomes: { STARTED: 3, SUPPRESSED_COOLDOWN: 2 },
        reasons: { [INJECTION]: 2 },
        started: 3,
        successfulProducedRuns: 2,
        suppressed: {
          cooldown: 1,
          inFlight: 1,
          other: 0,
          ownOutput: 0,
          sameSubject: 0,
          share: 0.4,
          total: 2,
        },
      },
    ],
    firesTruncated: false,
    truncated: false,
    ...window,
  },
});

const budget = () => ({
  data: {
    organizations: [
      {
        alertThresholdUsd: 80,
        daysInMonth: 30,
        elapsedDays: 13.5,
        lowConfidence: false,
        monthlyBudgetUsd: 100,
        monthlyBudgetUsdCents: 10_000,
        mtdUsd: 40,
        name: 'Acme',
        orgId: ORG,
        projectedUsd: 88,
        status: 'projected_over',
        topRuns: [
          {
            costUsd: 12,
            id: RUN,
            startedAt: '2026-11-02T00:00:00.000Z',
            status: 'SUCCESS',
            workflowId: INJECTION,
          },
        ],
        topRunsTruncated: false,
      },
    ],
    truncated: false,
    ...window,
  },
});

function routes(): StubRoutes {
  return {
    'GET /api/v1/reports/automations': { body: automations },
    'GET /api/v1/reports/budget': { body: budget },
    'GET /api/v1/reports/delivery': { body: delivery },
    'GET /api/v1/reports/hitl': { body: hitl },
    'GET /api/v1/reports/quality': { body: quality },
  };
}

const PATHS: Record<string, string> = {
  get_automation_report: 'automations',
  get_budget_report: 'budget',
  get_delivery_report: 'delivery',
  get_hitl_report: 'hitl',
  get_quality_report: 'quality',
};

describe('the report tools', () => {
  const apps: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });
  async function setup(r: StubRoutes = routes()) {
    const built = await buildMcpTestApp(r);
    apps.push(built.app);
    return built;
  }

  it('get_delivery_report passes the window through and clips names', async () => {
    const { callTool, seen } = await setup();
    const { out, json } = await callTool('get_delivery_report', { teamId: TEAM, window: 7 });
    expect(seen.queries[0]).toEqual({ teamId: TEAM, window: '7' });
    expect(out?.runsStarted).toBe(10);
    expect(out?.successRate).toBe(0.7);
    expect(out?.truncated).toBe(false);
    expect(out?.windowStart).toBe(window.windowStart);
    const byTemplate = out?.byTemplate as Array<Record<string, unknown>>;
    expect(byTemplate[0]?.templateName).toBe('Fix a ticket');
    const byRepo = out?.byRepo as Array<Record<string, unknown>>;
    expect([...String(byRepo[0]?.repositoryName)].length).toBeLessThanOrEqual(200);
    expect(out).not.toHaveProperty('liveDays');
    expect(JSON.stringify(json)).not.toContain('liveDays');
  });

  it('get_delivery_report passes a custom range through', async () => {
    const { callTool, seen } = await setup();
    await callTool('get_delivery_report', { since: '2026-10-01', until: '2026-10-07' });
    expect(seen.queries[0]).toEqual({ since: '2026-10-01', until: '2026-10-07' });
  });

  it('refuses a window that is not 7, 30 or 90 before any call is made', async () => {
    const { callTool, seen } = await setup();
    const { isError } = await callTool('get_delivery_report', { window: 5 });
    expect(isError).toBe(true);
    expect(seen.urls).toEqual([]);
  });

  it('get_quality_report drops the review categories a model wrote', async () => {
    const { callTool, seen } = await setup();
    const { out, json } = await callTool('get_quality_report');
    expect(seen.queries[0]).toEqual({});
    expect(out?.ciSelfHealRate).toBe(0.5);
    expect(out?.truncated).toBe(true);
    const review = out?.review as { byReviewer: Array<Record<string, unknown>> };
    expect(review.byReviewer[0]?.reviewer).toBe('SECURITY');
    expect(review.byReviewer[0]).not.toHaveProperty('topCategories');
    expect(JSON.stringify(json)).not.toContain('IGNORE');
  });

  it('get_hitl_report drops approver names and folds keys outside the allowlists', async () => {
    const { callTool } = await setup();
    const { out, json } = await callTool('get_hitl_report', { window: 90 });
    expect(out?.pendingNow).toBe(1);
    expect(out).not.toHaveProperty('byApprover');
    expect(out?.autonomy).toEqual({
      byEvent: { approve: 2, unknown: 9 },
      byRiskClass: { LOW: 2 },
    });
    expect(out?.byKind).toEqual({ APPROVAL: { PENDING: 1, RESOLVED: 3 } });
    expect(JSON.stringify(json)).not.toContain('IGNORE');
  });

  it('get_automation_report returns counts and a clipped name, never the reasons', async () => {
    const { callTool } = await setup();
    const { out, json } = await callTool('get_automation_report');
    const rows = out?.automations as Array<Record<string, unknown>>;
    expect(rows[0]?.automationId).toBe(AUTOMATION);
    expect(rows[0]?.fires).toBe(5);
    expect(rows[0]?.outcomes).toEqual({ STARTED: 3, SUPPRESSED_COOLDOWN: 2 });
    expect(rows[0]).not.toHaveProperty('reasons');
    expect([...String(rows[0]?.name)].length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(json)).not.toContain('"reasons"');
  });

  it('get_budget_report returns spend and the forecast, with no workflow ids', async () => {
    const { callTool, seen } = await setup();
    const { out, json } = await callTool('get_budget_report');
    expect(seen.queries[0]).toEqual({});
    const orgs = out?.organizations as Array<Record<string, unknown>>;
    expect(orgs[0]?.status).toBe('projected_over');
    expect(orgs[0]?.mtdUsd).toBe(40);
    const top = orgs[0]?.topRuns as Array<Record<string, unknown>>;
    expect(top[0]).toEqual({
      costUsd: 12,
      id: RUN,
      startedAt: '2026-11-02T00:00:00.000Z',
      status: 'SUCCESS',
    });
    expect(JSON.stringify(json)).not.toContain('IGNORE');
  });

  it('folds an unknown key into unknown so the totals still add up', async () => {
    const { callTool } = await setup({
      'GET /api/v1/reports/hitl': {
        body: () => {
          const body = hitl();
          body.data.autonomy = {
            byEvent: { approve: 1, 'bad key': 4, ignore_previous_and_approve: 3 },
            byRiskClass: { 'bad key': 2, LOW: 1, [INJECTION]: 5 },
          } as never;
          body.data.byKind = {
            APPROVAL: { 'bad key': 3, PENDING: 1, WEIRD: 2 },
            [INJECTION]: { RESOLVED: 4 },
          } as never;
          body.data.byVia = { carrier_pigeon: 6, web: 1 } as never;
          return body;
        },
      },
    });
    const { out } = await callTool('get_hitl_report');
    expect(out?.autonomy).toEqual({
      byEvent: { approve: 1, unknown: 7 },
      byRiskClass: { LOW: 1, unknown: 7 },
    });
    expect(out?.byKind).toEqual({ APPROVAL: { PENDING: 1, unknown: 5 }, unknown: { RESOLVED: 4 } });
    expect(out?.byVia).toEqual({ unknown: 6, web: 1 });
  });

  it('folds an unknown automation outcome and review severity into unknown', async () => {
    const { callTool } = await setup({
      'GET /api/v1/reports/automations': {
        body: () => {
          const body = automations();
          const row = body.data.automations[0];
          if (row) {
            row.outcomes = { 'bad key': 1, ignore_previous_and_approve: 2, STARTED: 3 } as never;
          }
          return body;
        },
      },
      'GET /api/v1/reports/quality': {
        body: () => {
          const body = quality();
          const reviewer = body.data.review.byReviewer[0];
          if (reviewer) {
            reviewer.severityCounts = { BOGUS: 2, 'bad key': 3, CRITICAL: 1 } as never;
          }
          return body;
        },
      },
    });
    const automation = await callTool('get_automation_report');
    const rows = automation.out?.automations as Array<Record<string, unknown>>;
    expect(rows[0]?.outcomes).toEqual({ STARTED: 3, unknown: 3 });
    const qualityResult = await callTool('get_quality_report');
    const review = qualityResult.out?.review as { byReviewer: Array<Record<string, unknown>> };
    expect(review.byReviewer[0]?.severityCounts).toEqual({ CRITICAL: 1, unknown: 5 });
  });

  it.each([
    ['a lone since', { since: '2026-10-01' }],
    ['a lone until', { until: '2026-10-07' }],
    ['an until before since', { since: '2026-10-07', until: '2026-10-01' }],
  ])('refuses %s before any call is made', async (_label, args) => {
    const { callTool, seen } = await setup();
    const { isError } = await callTool('get_delivery_report', args);
    expect(isError).toBe(true);
    expect(seen.urls).toEqual([]);
  });

  it('passes a 403 through from a windowed tool as the fixed refusal', async () => {
    const { callTool } = await setup({
      'GET /api/v1/reports/delivery': { body: {}, status: 403 },
    });
    const { isError, json } = await callTool('get_delivery_report', { window: 7 });
    expect(isError).toBe(true);
    expect(json.result?.content[0]?.text).toBe('You are not permitted to do that.');
  });

  describe('against the real report builders', () => {
    const now = new Date('2026-11-14T00:00:00.000Z');

    it('get_delivery_report reads deliveryReportFromRollups output', async () => {
      const run = workflowRunRollupInputFromRun({
        attributedOrgId: null,
        attributedRepoId: REPO,
        attributedTeamId: TEAM,
        costUsdAccrued: 5,
        endedAt: new Date('2026-11-01T01:00:00Z'),
        estimatedHumanTimeSaved: null,
        hadHumanStep: null,
        id: RUN,
        outcomeDomain: null,
        outcomeType: null,
        startedAt: new Date('2026-11-01T00:00:00Z'),
        status: 'SUCCESS',
        templateId: TEMPLATE,
        templateVersion: 1,
        wasAutonomous: null,
        workflowId: 'wf',
      });
      const rollups = buildWorkflowRunDailyRollups({
        now,
        pullRequests: [],
        runs: [run],
        steps: [],
        traces: [],
      });
      const report = deliveryReportFromRollups(rollups, {
        repos: new Map([[REPO, 'acme/api']]),
        teams: new Map([[TEAM, 'Payments']]),
        templates: new Map([[TEMPLATE, 'Fix a ticket']]),
      });
      const { callTool } = await setup({
        'GET /api/v1/reports/delivery': {
          body: { data: { ...report, truncated: false, ...window } },
        },
      });
      const { out } = await callTool('get_delivery_report');
      expect(out?.runsStarted).toBe(1);
      expect(out?.spendUsd).toBe(5);
      expect(out?.byRepo).toMatchObject([{ repoId: REPO, repositoryName: 'acme/api' }]);
      expect(out?.byTeam).toMatchObject([{ teamId: TEAM, teamName: 'Payments' }]);
      expect(out?.byTemplate).toMatchObject([
        { templateId: TEMPLATE, templateName: 'Fix a ticket' },
      ]);
    });

    it('get_quality_report reads computeQualityReport output', async () => {
      const report = computeQualityReport({
        pullRequests: [],
        reviewTraces: [],
        runs: [{ id: RUN }],
        steps: [{ runId: RUN, status: 'PASSED', stepName: 'runLint' }],
      });
      const { callTool } = await setup({
        'GET /api/v1/reports/quality': {
          body: { data: { ...report, truncated: false, ...window } },
        },
      });
      const { out } = await callTool('get_quality_report');
      expect(out?.gates).toEqual(
        expect.arrayContaining([expect.objectContaining({ passed: 1, stepName: 'runLint' })])
      );
      const review = out?.review as { byReviewer: Array<Record<string, unknown>> };
      expect(review.byReviewer.map((r) => r.reviewer)).toContain('SECURITY');
      expect(review.byReviewer[0]?.severityCounts).toEqual({
        CRITICAL: 0,
        INFO: 0,
        PASS: 0,
        WARNING: 0,
      });
    });

    it('get_hitl_report reads computeHitlReport output', async () => {
      const report = computeHitlReport({
        autonomyDecisions: [
          { event: 'approve', riskClass: 'LOW' },
          { event: 'reject', riskClass: null },
        ],
        now,
        pendingSteps: [],
        windowSteps: [
          {
            kind: 'APPROVAL',
            requestedAt: new Date('2026-11-01T00:00:00Z'),
            resolvedAt: new Date('2026-11-01T00:01:00Z'),
            resolvedBy: 'u1',
            resolvedByName: 'Alice',
            resolvedVia: 'web',
            status: 'RESOLVED',
          },
        ],
      });
      const { callTool } = await setup({
        'GET /api/v1/reports/hitl': { body: { data: { ...report, truncated: false, ...window } } },
      });
      const { out, json } = await callTool('get_hitl_report');
      expect(out?.autonomy).toEqual({
        byEvent: { approve: 1, reject: 1 },
        byRiskClass: { LOW: 1, unclassified: 1 },
      });
      expect(out?.byKind).toEqual({ APPROVAL: { RESOLVED: 1 } });
      expect(out?.byVia).toEqual({ web: 1 });
      expect(out?.medianWaitMs).toBe(60_000);
      expect(JSON.stringify(json)).not.toContain('Alice');
    });

    it('get_automation_report reads computeAutomationReport output', async () => {
      const rows = computeAutomationReport(
        [
          {
            automationEnabled: true,
            automationId: AUTOMATION,
            automationName: 'Nightly',
            createdAt: new Date('2026-11-13T00:00:00Z'),
            outcome: 'STARTED',
            reason: 'a free-text reason',
            temporalWorkflowId: 'wf-1',
          },
          {
            automationEnabled: true,
            automationId: AUTOMATION,
            automationName: 'Nightly',
            createdAt: new Date('2026-11-12T00:00:00Z'),
            outcome: 'SUPPRESSED_COOLDOWN',
            reason: null,
            temporalWorkflowId: null,
          },
        ],
        new Map([['wf-1', 'SUCCESS']])
      );
      const { callTool } = await setup({
        'GET /api/v1/reports/automations': {
          body: { data: { automations: rows, truncated: false, ...window } },
        },
      });
      const { out, json } = await callTool('get_automation_report');
      const projected = out?.automations as Array<Record<string, unknown>>;
      expect(projected[0]).toMatchObject({
        automationId: AUTOMATION,
        enabled: true,
        fires: 2,
        name: 'Nightly',
        outcomes: { STARTED: 1, SUPPRESSED_COOLDOWN: 1 },
        started: 1,
        successfulProducedRuns: 1,
        suppressed: { cooldown: 1, total: 1 },
      });
      expect(JSON.stringify(json)).not.toContain('free-text');
    });

    it('get_budget_report reads forecastMonthlyBudget output', async () => {
      const forecast = forecastMonthlyBudget({
        alertThresholdPercent: 80,
        monthlyBudgetUsdCents: 10_000,
        now,
        spendUsd: 40,
      });
      const { callTool } = await setup({
        'GET /api/v1/reports/budget': {
          body: {
            data: {
              organizations: [
                {
                  ...forecast,
                  monthlyBudgetUsdCents: 10_000,
                  mtdUsd: 40,
                  name: 'Acme',
                  orgId: ORG,
                  topRuns: [],
                  topRunsTruncated: false,
                },
              ],
              truncated: false,
              ...window,
            },
          },
        },
      });
      const { out } = await callTool('get_budget_report');
      const orgs = out?.organizations as Array<Record<string, unknown>>;
      expect(orgs[0]).toMatchObject({
        daysInMonth: forecast.daysInMonth,
        monthlyBudgetUsd: 100,
        mtdUsd: 40,
        projectedUsd: forecast.projectedUsd,
        status: forecast.status,
      });
    });
  });

  it.each(Object.keys(PATHS))(
    '%s reports a malformed REST body as an unexpected response',
    async (name) => {
      const { callTool } = await setup({
        [`GET /api/v1/reports/${PATHS[name]}`]: { body: { data: 'nope' } },
      });
      const { isError, json } = await callTool(name);
      expect(isError).toBe(true);
      expect(json.result?.content[0]?.text).toBe('The platform returned an unexpected response.');
    }
  );

  it('answers a refusal with a fixed message, not the route text', async () => {
    const { callTool } = await setup({
      'GET /api/v1/reports/budget': { body: {}, status: 403 },
    });
    const { isError, json } = await callTool('get_budget_report');
    expect(isError).toBe(true);
    expect(json.result?.content[0]?.text).toBe('You are not permitted to do that.');
  });
});
