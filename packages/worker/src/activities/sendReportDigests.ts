import { prisma } from '@auto-swe/shared/db';
import { orgMonthSpend } from '@auto-swe/shared/lib/billing';
import { forecastMonthlyBudget } from '@auto-swe/shared/lib/budgetForecast';
import { resolveWebUrl } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import {
  buildReportDigest,
  QUALITY_GATE_STEPS,
  WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
} from '@auto-swe/shared/workflow';
import { heartbeat } from '@temporalio/activity';
import { logWarn } from '../lib/activityLog.js';
import { sendReportDigestEmail } from '../lib/reportDigestEmail.js';
import { postSlackChannelMessage } from '../lib/slackNotify.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_REPORT_DIGEST_GATE_ROWS = 50_000;

type DigestErrorCode = 'build_failed' | 'email_failed' | 'rollup_incomplete' | 'slack_failed';

function cleanHeading(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export async function sendReportDigests(
  input: { now?: Date; subscriptionId?: string; sendTest?: boolean } = {}
): Promise<{ failed: number; sent: number; skipped: number }> {
  const now = input.now ?? new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const currentStart = new Date(today - 7 * DAY_MS);
  const currentEnd = new Date(today);
  const previousStart = new Date(today - 14 * DAY_MS);
  const subscriptions = await runUnscoped(
    'the report digest sweep lists enabled digest subscriptions',
    ['ReportDigestSubscription'],
    () =>
      prisma.reportDigestSubscription.findMany({
        include: {
          organization: {
            select: {
              budgetAlertThresholdPercent: true,
              id: true,
              monthlyBudgetUsdCents: true,
              name: true,
            },
          },
          slackChannel: { select: { slackChannelId: true } },
          team: {
            select: {
              id: true,
              name: true,
              organization: {
                select: {
                  budgetAlertThresholdPercent: true,
                  id: true,
                  monthlyBudgetUsdCents: true,
                  name: true,
                },
              },
              orgId: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        where: {
          enabled: true,
          ...(input.subscriptionId ? { id: input.subscriptionId } : {}),
        },
      })
  );
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const subscription of subscriptions) {
    heartbeat(`processing report digest subscription ${subscription.id}`);
    try {
      const coveredDays = await runUnscoped(
        'the report digest checks coverage for its 14 completed rollup days',
        ['WorkflowRunDailyRollup'],
        () =>
          prisma.workflowRunDailyRollup.groupBy({
            by: ['day'],
            where: {
              bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
              day: { gte: previousStart, lt: currentEnd },
            },
          })
      );
      const covered = new Set(coveredDays.map(({ day }) => day.getTime()));
      const hasCompleteCoverage = Array.from(
        { length: 14 },
        (_, index) => previousStart.getTime() + index * DAY_MS
      ).every((day) => covered.has(day));
      if (!hasCompleteCoverage) {
        await recordDigestError(subscription.id, 'rollup_incomplete');
        skipped++;
        continue;
      }
      if (!input.sendTest) {
        const claim = await runUnscoped(
          'the report digest claims one delivery for its reporting period',
          ['ReportDigestSubscription'],
          () =>
            prisma.reportDigestSubscription.updateMany({
              data: { lastError: null, lastPeriodStart: currentStart },
              where: {
                id: subscription.id,
                OR: [{ lastPeriodStart: null }, { lastPeriodStart: { lt: currentStart } }],
              },
            })
        );
        if (claim.count === 0) {
          skipped++;
          continue;
        }
      }

      let digest: ReturnType<typeof buildReportDigest>;
      try {
        const scopeFilter =
          subscription.scope === 'ORGANIZATION'
            ? { orgId: subscription.orgId }
            : { teamId: subscription.teamId };
        const rows = await runUnscoped(
          'the report digest reads weekly rollups for the subscription scope',
          ['WorkflowRunDailyRollup'],
          () =>
            prisma.workflowRunDailyRollup.findMany({
              orderBy: [{ day: 'asc' }, { id: 'asc' }],
              where: {
                ...scopeFilter,
                bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
                day: { gte: previousStart, lt: currentEnd },
              },
            })
        );
        const currentRows = rows.filter((row) => row.day >= currentStart);
        const previousRows = rows.filter((row) => row.day < currentStart);
        const scopeWhere =
          subscription.scope === 'ORGANIZATION'
            ? { attributedOrgId: subscription.orgId }
            : { attributedTeamId: subscription.teamId };
        const [pendingCount, oldestApproval, gates, templates] = await Promise.all([
          runUnscoped(
            'the report digest counts pending approvals attributed to its scope',
            ['WorkflowHumanStep', 'WorkflowRun'],
            () =>
              prisma.workflowHumanStep.count({
                where: { run: scopeWhere, status: 'PENDING' },
              })
          ),
          runUnscoped(
            'the report digest finds the oldest pending approval attributed to its scope',
            ['WorkflowHumanStep', 'WorkflowRun'],
            () =>
              prisma.workflowHumanStep.findFirst({
                orderBy: { requestedAt: 'asc' },
                select: { requestedAt: true },
                where: { run: scopeWhere, status: 'PENDING' },
              })
          ),
          runUnscoped(
            'the report digest aggregates quality gates for scoped runs in the current period',
            ['WorkflowStep', 'WorkflowRun'],
            () =>
              prisma.workflowStep.groupBy({
                _count: { _all: true },
                by: ['runId', 'stepName', 'status'],
                orderBy: { runId: 'asc' },
                take: MAX_REPORT_DIGEST_GATE_ROWS,
                where: {
                  run: { ...scopeWhere, startedAt: { gte: currentStart, lt: currentEnd } },
                  stepName: { in: [...QUALITY_GATE_STEPS] },
                },
              })
          ),
          runUnscoped(
            'the report digest resolves template names for scoped rollup rows',
            ['WorkflowTemplate'],
            () =>
              prisma.workflowTemplate.findMany({
                select: { id: true, name: true, team: { select: { name: true } }, teamId: true },
                where: {
                  id: {
                    in: [
                      ...new Set(
                        currentRows
                          .map((row) => row.templateId)
                          .filter((id): id is string => id !== null)
                      ),
                    ],
                  },
                },
              })
          ),
        ]);
        const pairs = new Map<string, { passed: boolean; name: string }>();
        for (const gate of gates) {
          if (!gate.runId || !gate.stepName) {
            continue;
          }
          const key = `${gate.runId}:${gate.stepName}`;
          const pair = pairs.get(key) ?? { name: gate.stepName, passed: false };
          pair.passed ||= gate.status === 'PASSED';
          pairs.set(key, pair);
        }
        const byGate = new Map<string, { passed: number; pairs: number }>();
        for (const pair of pairs.values()) {
          const gate = byGate.get(pair.name) ?? { pairs: 0, passed: 0 };
          gate.pairs++;
          if (pair.passed) {
            gate.passed++;
          }
          byGate.set(pair.name, gate);
        }
        const worstGate = [...byGate.entries()]
          .map(([name, value]) => ({
            finalPassRate: value.passed / value.pairs,
            name,
            pairs: value.pairs,
          }))
          .filter((gate) => gate.pairs >= 10)
          .sort((a, b) => a.finalPassRate - b.finalPassRate)[0];
        const templateNames = new Map<string, string>();
        for (const template of templates) {
          const name = cleanHeading(template.name);
          if (subscription.scope === 'ORGANIZATION') {
            templateNames.set(
              template.id,
              template.teamId ? `${cleanHeading(template.team?.name ?? 'Team')} template` : name
            );
          } else if (template.teamId === null || template.teamId === subscription.teamId) {
            templateNames.set(template.id, name);
          } else {
            templateNames.set(template.id, 'Private template');
          }
        }
        for (const row of currentRows) {
          if (row.templateId && !templateNames.has(row.templateId)) {
            templateNames.set(row.templateId, 'Private template');
          }
        }
        const organization =
          subscription.scope === 'ORGANIZATION'
            ? subscription.organization
            : subscription.team?.organization;
        const budget =
          subscription.scope === 'ORGANIZATION' && organization && subscription.orgId
            ? await (async () => {
                const spend = await orgMonthSpend(prisma, subscription.orgId as string);
                const forecast = forecastMonthlyBudget({
                  alertThresholdPercent: organization.budgetAlertThresholdPercent,
                  monthlyBudgetUsdCents: organization.monthlyBudgetUsdCents,
                  now,
                  spendUsd: spend.totalUsd,
                });
                return {
                  mtdUsd: spend.totalUsd,
                  projectedUsd: forecast.projectedUsd,
                  status: forecast.status,
                };
              })()
            : undefined;
        digest = buildReportDigest({
          budget,
          currentPeriod: { end: new Date(currentEnd.getTime() - DAY_MS), start: currentStart },
          currentRows,
          now,
          oldestPendingApprovalRequestedAt: oldestApproval?.requestedAt ?? null,
          pendingApprovalCount: pendingCount,
          previousPeriod: { end: new Date(currentStart.getTime() - DAY_MS), start: previousStart },
          previousRows,
          reportsUrl: `${resolveWebUrl().replace(/\/$/, '')}/admin/reports`,
          scope: {
            name: cleanHeading(
              subscription.scope === 'ORGANIZATION'
                ? (subscription.organization?.name ?? 'Organization')
                : (subscription.team?.name ?? 'Team')
            ),
            type: subscription.scope,
          },
          templateNames,
          worstGate: gates.length === MAX_REPORT_DIGEST_GATE_ROWS ? undefined : worstGate,
          worstGateNotComputed: gates.length === MAX_REPORT_DIGEST_GATE_ROWS,
        });
      } catch (error) {
        logWarn('report digest build failed', {
          error: error instanceof Error ? error.message : String(error),
          subscriptionId: subscription.id,
        });
        await recordDigestError(subscription.id, 'build_failed');
        failed++;
        continue;
      }

      let deliveryError: 'email_failed' | 'slack_failed' | null = null;
      if (subscription.emailRecipients.length) {
        try {
          for (const to of subscription.emailRecipients) {
            await sendReportDigestEmail({
              html: digest.html,
              subject: digest.subject,
              text: digest.text,
              to,
            });
          }
        } catch (error) {
          deliveryError = 'email_failed';
          logWarn('report digest email delivery failed', {
            error: error instanceof Error ? error.message : String(error),
            subscriptionId: subscription.id,
          });
        }
      }
      if (subscription.slackChannel) {
        try {
          await postSlackChannelMessage(
            subscription.slackChannel.slackChannelId,
            digest.slackMrkdwn
          );
        } catch (error) {
          deliveryError ??= 'slack_failed';
          logWarn('report digest Slack delivery failed', {
            error: error instanceof Error ? error.message : String(error),
            subscriptionId: subscription.id,
          });
        }
      }
      if (deliveryError) {
        await recordDigestError(subscription.id, deliveryError);
        failed++;
        continue;
      }
      await runUnscoped(
        'the report digest sweep records successful delivery',
        ['ReportDigestSubscription'],
        () =>
          prisma.reportDigestSubscription.update({
            data: { lastError: null, ...(!input.sendTest ? { lastSentAt: now } : {}) },
            where: { id: subscription.id },
          })
      );
      sent++;
    } catch (error) {
      logWarn('report digest subscription failed', {
        error: error instanceof Error ? error.message : String(error),
        subscriptionId: subscription.id,
      });
      await recordDigestError(subscription.id, 'build_failed');
      failed++;
    } finally {
      heartbeat(`finished report digest subscription ${subscription.id}`);
    }
  }
  return { failed, sent, skipped };
}

async function recordDigestError(subscriptionId: string, code: DigestErrorCode): Promise<void> {
  try {
    await runUnscoped(
      'the report digest sweep records a short delivery status code',
      ['ReportDigestSubscription'],
      () =>
        prisma.reportDigestSubscription.update({
          data: { lastError: code },
          where: { id: subscriptionId },
        })
    );
  } catch (error) {
    logWarn('report digest status could not be recorded', {
      error: error instanceof Error ? error.message : String(error),
      subscriptionId,
    });
  }
}
