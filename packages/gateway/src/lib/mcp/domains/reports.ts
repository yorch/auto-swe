import { z } from 'zod';
import type { BridgeResponse } from '../bridge.js';
import { shortName, status, timestamp } from '../projections.js';
import type { ToolKit } from '../toolKit.js';
import { query } from '../toolKit.js';
import type { McpDomain } from './index.js';

/**
 * Reports: the aggregate delivery, quality, approval, automation and budget figures the dashboard
 * charts. They are counts, rates, durations and dollar amounts. What a person or a model wrote
 * stays out: an approver's name, the free-text reasons an automation was suppressed, and the
 * categories a reviewer model gave its findings are not returned, and a workflow id (which
 * embeds a repository and ticket name) is replaced by the run id. The names that remain
 * (repository, team, template, automation, organization) are clipped like every other name.
 */

/**
 * Bucket keys are folded, never dropped: a key outside its allowlist is added into `unknown`, so
 * every bucket still sums to the total the route counted. The allowlists are inlined because MCP
 * code imports no shared module; each mirrors the constant named beside it.
 */
const UNKNOWN = 'unknown';

/** `DECISION_EVENTS` in `runEvidence.ts`, which mirrors the autonomy decision events. */
const DECISION_EVENTS = [
  'publish',
  'approve',
  'reject',
  'approve_partial',
  'request_changes',
  'select',
  'submit',
] as const;
/** `AUTOMATION_OUTCOMES` in `shared/automation/types.ts`. */
const AUTOMATION_OUTCOMES = [
  'STARTED',
  'SUPPRESSED_OWN_OUTPUT',
  'SUPPRESSED_SAME_SUBJECT',
  'SUPPRESSED_COOLDOWN',
  'SUPPRESSED_IN_FLIGHT',
  'SUPPRESSED_DAILY_CAP',
  'SUPPRESSED_PRECONDITION',
  'SUPPRESSED_BUDGET',
  'FAILED_TO_START',
] as const;
/** `REVIEW_SEVERITIES` in `shared/workflow/reports.ts`. */
const REVIEW_SEVERITIES = ['PASS', 'INFO', 'WARNING', 'CRITICAL'] as const;
/** The `HumanStepKind` enum. */
const HUMAN_STEP_KINDS = ['APPROVAL', 'DECISION', 'INPUT', 'REVIEW'] as const;
/** The `HumanStepStatus` enum. */
const HUMAN_STEP_STATUSES = ['PENDING', 'RESOLVED', 'TIMED_OUT', 'CANCELLED'] as const;
/** The values `computeHitlReport` records for how a step was resolved. */
const RESOLVED_VIA = ['web', 'slack', 'api_token', 'mcp', 'assistant'] as const;
/**
 * A risk class is written by the workflow author (a template's action), so there is no closed set
 * to allow; only the shape of an identifier is checked, and the rest is folded into `unknown`.
 */
const OPEN_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/;

function fold(
  record: Record<string, number>,
  isAllowed: (key: string) => boolean
): Record<string, number> {
  const folded: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    const target = isAllowed(key) ? key : UNKNOWN;
    folded[target] = (folded[target] ?? 0) + value;
  }
  return folded;
}

const allowlisted = (allowed: readonly string[]) => (key: string) => allowed.includes(key);

const counts = (allowed: readonly string[]) =>
  z.record(z.string(), z.number()).transform((record) => fold(record, allowlisted(allowed)));
const openCounts = z
  .record(z.string(), z.number())
  .transform((record) => fold(record, (key) => OPEN_KEY.test(key)));
const kindCounts = z.record(z.string(), z.record(z.string(), z.number())).transform((record) => {
  const folded: Record<string, Record<string, number>> = {};
  for (const [kind, statuses] of Object.entries(record)) {
    const target = HUMAN_STEP_KINDS.some((k) => k === kind) ? kind : UNKNOWN;
    const inner = fold(statuses, allowlisted(HUMAN_STEP_STATUSES));
    const into = folded[target] ?? {};
    folded[target] = into;
    for (const [name, value] of Object.entries(inner)) {
      into[name] = (into[name] ?? 0) + value;
    }
  }
  return folded;
});

const countsOutput = z.record(z.string(), z.number());
const nestedCountsOutput = z.record(z.string(), countsOutput);

const rate = z.number().nullable();

/** The figures every delivery row carries; the REST body and the tool output share this shape. */
const metrics = {
  ciFixRounds: z.object({ avgPerRun: rate, p95PerRun: rate }),
  costPerMergedPr: rate,
  medianTimeToMergeMs: rate,
  prsCiPassed: z.number(),
  prsMerged: z.number(),
  runsStarted: z.number(),
  runsSucceeded: z.number(),
  runsWithPr: z.number(),
  spendUsd: z.number(),
  successRate: rate,
};

/** Suppressed fires by cause; the REST body and the tool output share this shape. */
const suppressed = z.object({
  cooldown: z.number(),
  inFlight: z.number(),
  other: z.number(),
  ownOutput: z.number(),
  sameSubject: z.number(),
  share: z.number(),
  total: z.number(),
});

const restWindow = { windowEnd: timestamp, windowStart: timestamp };
const outputWindow = { windowEnd: z.string(), windowStart: z.string() };

const windowInput = {
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('First day of a custom range, YYYY-MM-DD (UTC, inclusive); pass with until'),
  teamId: z.string().uuid().optional().describe('Only this team; you must be allowed to see it'),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Last day of a custom range, YYYY-MM-DD (UTC, inclusive); pass with since'),
  window: z
    .union([z.literal(7), z.literal(30), z.literal(90)])
    .optional()
    .describe('Trailing days, 7, 30 or 90 (default 30); a custom range replaces it'),
};

// ── delivery ──

const restDelivery = z.object({
  data: z.object({
    ...metrics,
    byRepo: z.array(z.object({ ...metrics, repoId: z.string(), repositoryName: shortName(200) })),
    byTeam: z.array(
      z.object({ ...metrics, teamId: z.string().nullable(), teamName: shortName(200) })
    ),
    byTemplate: z.array(
      z.object({ ...metrics, templateId: z.string(), templateName: shortName(200) })
    ),
    truncated: z.boolean(),
    ...restWindow,
  }),
});

const deliveryOutput = z.object({
  ...metrics,
  byRepo: z.array(z.object({ ...metrics, repoId: z.string(), repositoryName: z.string() })),
  byTeam: z.array(z.object({ ...metrics, teamId: z.string().nullable(), teamName: z.string() })),
  byTemplate: z.array(z.object({ ...metrics, templateId: z.string(), templateName: z.string() })),
  /** True when a row cap was reached, so the figures cover only part of the window. */
  truncated: z.boolean(),
  ...outputWindow,
});

// ── quality ──

const rejection = z.object({ mergedRuns: z.number(), mergeRate: rate, runsWithPr: z.number() });

const restQuality = z.object({
  data: z.object({
    ciSelfHealRate: rate,
    fixLoops: z.array(
      z.object({
        avgAttemptsPerRun: rate,
        runsWithFix: z.number(),
        stepName: shortName(100),
        totalAttempts: z.number(),
      })
    ),
    gates: z.array(
      z.object({
        attempts: z.number(),
        failed: z.number(),
        finalPassRate: rate,
        firstAttemptPassRate: rate,
        passed: z.number(),
        stepName: shortName(100),
      })
    ),
    mergeRateByReviewOutcome: z.object({
      withoutRejectingVerdict: rejection,
      withRejectingVerdict: rejection,
    }),
    review: z.object({
      byReviewer: z.array(
        z.object({
          approvalRate: rate,
          approved: z.number(),
          findingsTotal: z.number(),
          reviewer: shortName(50),
          severityCounts: counts(REVIEW_SEVERITIES),
          verdicts: z.number(),
        })
      ),
      nonVerdictRows: z.number(),
    }),
    truncated: z.boolean(),
    ...restWindow,
  }),
});

const qualityOutput = z.object({
  ciSelfHealRate: rate,
  fixLoops: z.array(
    z.object({
      avgAttemptsPerRun: rate,
      runsWithFix: z.number(),
      stepName: z.string(),
      totalAttempts: z.number(),
    })
  ),
  gates: z.array(
    z.object({
      attempts: z.number(),
      failed: z.number(),
      finalPassRate: rate,
      firstAttemptPassRate: rate,
      passed: z.number(),
      stepName: z.string(),
    })
  ),
  mergeRateByReviewOutcome: z.object({
    withoutRejectingVerdict: rejection,
    withRejectingVerdict: rejection,
  }),
  review: z.object({
    byReviewer: z.array(
      z.object({
        approvalRate: rate,
        approved: z.number(),
        findingsTotal: z.number(),
        reviewer: z.string(),
        severityCounts: countsOutput,
        verdicts: z.number(),
      })
    ),
    nonVerdictRows: z.number(),
  }),
  truncated: z.boolean(),
  ...outputWindow,
});

// ── approvals (HITL) ──

const restHitl = z.object({
  data: z.object({
    autonomy: z.object({
      byEvent: counts([...DECISION_EVENTS]),
      byRiskClass: openCounts,
    }),
    byKind: kindCounts,
    byVia: counts(RESOLVED_VIA),
    medianWaitMs: rate,
    oldestPendingAgeMs: rate,
    p95WaitMs: rate,
    pendingNow: z.number(),
    timedOut: z.number(),
    truncated: z.boolean(),
    ...restWindow,
  }),
});

const hitlOutput = z.object({
  autonomy: z.object({ byEvent: countsOutput, byRiskClass: countsOutput }),
  byKind: nestedCountsOutput,
  byVia: countsOutput,
  medianWaitMs: rate,
  oldestPendingAgeMs: rate,
  p95WaitMs: rate,
  pendingNow: z.number(),
  timedOut: z.number(),
  truncated: z.boolean(),
  ...outputWindow,
});

// ── automations ──

const restAutomations = z.object({
  data: z.object({
    automations: z.array(
      z.object({
        automationEnabled: z.boolean().nullable(),
        automationId: z.string().uuid().nullable(),
        automationName: shortName(200),
        broken: z.boolean(),
        failedToStart: z.number(),
        fires: z.number(),
        lastFiredAt: timestamp,
        noisy: z.boolean(),
        outcomes: counts(AUTOMATION_OUTCOMES),
        started: z.number(),
        successfulProducedRuns: z.number(),
        suppressed,
      })
    ),
    truncated: z.boolean(),
    ...restWindow,
  }),
});

const automationsOutput = z.object({
  automations: z.array(
    z.object({
      automationId: z.string().uuid().nullable(),
      broken: z.boolean(),
      enabled: z.boolean().nullable(),
      failedToStart: z.number(),
      fires: z.number(),
      lastFiredAt: z.string(),
      name: z.string(),
      noisy: z.boolean(),
      outcomes: countsOutput,
      started: z.number(),
      successfulProducedRuns: z.number(),
      suppressed,
    })
  ),
  truncated: z.boolean(),
  ...outputWindow,
});

// ── budget ──

const budgetStatus = z.enum(['over', 'projected_over', 'alert', 'ok', 'no_cap']);

const restBudget = z.object({
  data: z.object({
    organizations: z.array(
      z.object({
        alertThresholdUsd: rate,
        daysInMonth: z.number(),
        elapsedDays: z.number(),
        lowConfidence: z.boolean(),
        monthlyBudgetUsd: rate,
        mtdUsd: z.number(),
        name: shortName(200),
        orgId: z.string().uuid(),
        projectedUsd: z.number(),
        status: budgetStatus,
        topRuns: z.array(
          z.object({
            costUsd: z.number(),
            id: z.string().uuid(),
            startedAt: timestamp,
            status,
          })
        ),
        topRunsTruncated: z.boolean(),
      })
    ),
    truncated: z.boolean(),
    ...restWindow,
  }),
});

const budgetOutput = z.object({
  organizations: z.array(
    z.object({
      alertThresholdUsd: rate,
      daysInMonth: z.number(),
      elapsedDays: z.number(),
      lowConfidence: z.boolean(),
      monthlyBudgetUsd: rate,
      mtdUsd: z.number(),
      name: z.string(),
      orgId: z.string().uuid(),
      projectedUsd: z.number(),
      status: budgetStatus,
      topRuns: z.array(
        z.object({
          costUsd: z.number(),
          id: z.string().uuid(),
          startedAt: z.string(),
          status: z.string(),
        })
      ),
      topRunsTruncated: z.boolean(),
    })
  ),
  truncated: z.boolean(),
  ...outputWindow,
});

export const reportsDomain: McpDomain = {
  name: 'reports',
  register({ get, readTool }: ToolKit) {
    // The tool's input is a plain shape, so a rule that spans two fields cannot be part of its
    // schema. A lone or inverted range is answered here, with no call made, as a refusal.
    const windowed =
      (path: string) =>
      async (args: Record<string, string | number | undefined>): Promise<BridgeResponse> => {
        const { since, until } = args;
        if ((since === undefined) !== (until === undefined)) {
          return { body: undefined, status: 400 };
        }
        if (typeof since === 'string' && typeof until === 'string' && until < since) {
          return { body: undefined, status: 400 };
        }
        return get(path, query(args));
      };

    readTool(
      'get_delivery_report',
      {
        description:
          'Delivery figures for a window: runs started and succeeded, pull requests opened, CI-passed and merged, spend, cost per merged pull request, median time to merge and CI fix rounds, in total and by repository, team and template. Default is the last 30 days; window 7, 30 or 90, or a since/until range. Counts only the runs you can see.',
        input: windowInput,
        output: deliveryOutput,
        title: 'Delivery report',
      },
      windowed('/api/v1/reports/delivery'),
      (body) => {
        const parsed = restDelivery.safeParse(body);
        return parsed.success ? parsed.data.data : null;
      }
    );

    readTool(
      'get_quality_report',
      {
        description:
          "Quality figures for a window: pass rates of the lint, test and build gates, CI fix loops and the rate at which CI self-heals, merge rate with and without a rejecting review verdict, and each reviewer persona's verdict and severity counts. Finding categories are not returned. Same window inputs as get_delivery_report.",
        input: windowInput,
        output: qualityOutput,
        title: 'Quality report',
      },
      windowed('/api/v1/reports/quality'),
      (body) => {
        const parsed = restQuality.safeParse(body);
        return parsed.success ? parsed.data.data : null;
      }
    );

    readTool(
      'get_hitl_report',
      {
        description:
          'Human-approval figures for a window: steps by kind and status, how they were resolved (web, Slack, API token, MCP, assistant), median and 95th percentile wait, how many are pending now and the age of the oldest, how many timed out, and autonomy decisions by event and risk class. Approver names are not returned. Same window inputs as get_delivery_report.',
        input: windowInput,
        output: hitlOutput,
        title: 'Approvals report',
      },
      windowed('/api/v1/reports/hitl'),
      (body) => {
        const parsed = restHitl.safeParse(body);
        return parsed.success ? parsed.data.data : null;
      }
    );

    readTool(
      'get_automation_report',
      {
        description:
          'Automation figures for a window, one row per automation you can see: fires, how many started a run, failed to start or were suppressed (by cause), runs produced that succeeded, and whether it looks broken or noisy. Suppression reasons are not returned. Same window inputs as get_delivery_report.',
        input: windowInput,
        output: automationsOutput,
        title: 'Automations report',
      },
      windowed('/api/v1/reports/automations'),
      (body) => {
        const parsed = restAutomations.safeParse(body);
        return parsed.success
          ? {
              automations: parsed.data.data.automations.map((a) => ({
                automationId: a.automationId,
                broken: a.broken,
                enabled: a.automationEnabled,
                failedToStart: a.failedToStart,
                fires: a.fires,
                lastFiredAt: a.lastFiredAt,
                name: a.automationName,
                noisy: a.noisy,
                outcomes: a.outcomes,
                started: a.started,
                successfulProducedRuns: a.successfulProducedRuns,
                suppressed: a.suppressed,
              })),
              truncated: parsed.data.data.truncated,
              windowEnd: parsed.data.data.windowEnd,
              windowStart: parsed.data.data.windowStart,
            }
          : null;
      }
    );

    readTool(
      'get_budget_report',
      {
        description:
          "This month's spend for each organization you administer (every organization for an administrator): month-to-date spend, the monthly cap and alert threshold, the projected month-end spend, a status (over, projected_over, alert, ok, no_cap), and the five costliest runs by id. For organization administrators; anyone else is refused. Takes no inputs: the window is the current UTC month.",
        input: {},
        output: budgetOutput,
        title: 'Budget report',
      },
      () => get('/api/v1/reports/budget'),
      (body) => {
        const parsed = restBudget.safeParse(body);
        return parsed.success ? parsed.data.data : null;
      }
    );
  },
  tools: [
    { name: 'get_automation_report', route: 'GET /api/v1/reports/automations', tier: 'user' },
    { name: 'get_budget_report', route: 'GET /api/v1/reports/budget', tier: 'admin' },
    { name: 'get_delivery_report', route: 'GET /api/v1/reports/delivery', tier: 'user' },
    { name: 'get_hitl_report', route: 'GET /api/v1/reports/hitl', tier: 'user' },
    { name: 'get_quality_report', route: 'GET /api/v1/reports/quality', tier: 'user' },
  ],
};
