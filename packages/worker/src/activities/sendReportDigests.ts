import { prisma } from '@auto-swe/shared/db';
import { orgMonthSpend } from '@auto-swe/shared/lib/billing';
import { forecastMonthlyBudget } from '@auto-swe/shared/lib/budgetForecast';
import { resolveWebUrl } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { buildReportDigest, QUALITY_GATE_STEPS } from '@auto-swe/shared/workflow';
import { sendReportDigestEmail } from '../lib/reportDigestEmail.js';
import { postSlackChannelMessage } from '../lib/slackNotify.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SIX_DAYS_MS = 6 * DAY_MS;

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
    if (
      !input.sendTest &&
      subscription.lastSentAt &&
      now.getTime() - subscription.lastSentAt.getTime() < SIX_DAYS_MS
    ) {
      skipped++;
      continue;
    }
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
            where: { ...scopeFilter, day: { gte: previousStart, lt: currentEnd } },
          })
      );
      const currentRows = rows.filter((row) => row.day >= currentStart);
      const previousRows = rows.filter((row) => row.day < currentStart);
      const scopeWhere =
        subscription.scope === 'ORGANIZATION'
          ? { attributedOrgId: subscription.orgId }
          : { attributedTeamId: subscription.teamId };
      const [pendingApprovals, gates, templates] = await Promise.all([
        runUnscoped(
          'the report digest counts pending approvals attributed to its scope',
          ['WorkflowHumanStep', 'WorkflowRun'],
          () =>
            prisma.workflowHumanStep.findMany({
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
              select: { id: true, name: true },
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
      const digest = buildReportDigest({
        budget,
        currentPeriod: { end: new Date(currentEnd.getTime() - DAY_MS), start: currentStart },
        currentRows,
        now,
        pendingApprovals,
        previousPeriod: { end: new Date(currentStart.getTime() - DAY_MS), start: previousStart },
        previousRows,
        reportsUrl: `${resolveWebUrl().replace(/\/$/, '')}/admin/reports`,
        scope: {
          name:
            subscription.scope === 'ORGANIZATION'
              ? (subscription.organization?.name ?? 'Organization')
              : (subscription.team?.name ?? 'Team'),
          type: subscription.scope,
        },
        templateNames: new Map(templates.map((template) => [template.id, template.name])),
        worstGate,
      });
      for (const to of subscription.emailRecipients) {
        await sendReportDigestEmail({
          html: digest.html,
          subject: digest.subject,
          text: digest.text,
          to,
        });
      }
      if (subscription.slackChannel) {
        await postSlackChannelMessage(subscription.slackChannel.slackChannelId, digest.slackMrkdwn);
      }
      if (!input.sendTest) {
        await runUnscoped(
          'the report digest sweep records successful delivery',
          ['ReportDigestSubscription'],
          () =>
            prisma.reportDigestSubscription.update({
              data: { lastError: null, lastSentAt: now },
              where: { id: subscription.id },
            })
        );
      }
      sent++;
    } catch (error) {
      failed++;
      try {
        await runUnscoped(
          'the report digest sweep records delivery failures',
          ['ReportDigestSubscription'],
          () =>
            prisma.reportDigestSubscription.update({
              data: {
                lastError: error instanceof Error ? error.message.slice(0, 2000) : 'Unknown error',
              },
              where: { id: subscription.id },
            })
        );
      } catch {}
    }
  }
  return { failed, sent, skipped };
}
