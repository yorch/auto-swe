import { prisma } from '@auto-swe/shared/db';
import { orgMonthSpend } from '@auto-swe/shared/lib/billing';
import { forecastMonthlyBudget } from '@auto-swe/shared/lib/budgetForecast';
import { createReportDigestUnsubscribeToken } from '@auto-swe/shared/lib/reportDigestUnsubscribe';
import { resolvePublicUrl, resolveWebUrl } from '@auto-swe/shared/lib/systemConfig';
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

type DigestErrorCode =
  | 'build_failed'
  | 'delivery_failed'
  | 'email_failed'
  | 'period_out_of_order'
  | 'period_too_soon'
  | 'rollup_incomplete'
  | 'slack_failed';

interface DigestTarget {
  email?: string;
  kind: 'email' | 'slack';
  key: string;
  slackChannelId?: string;
}

const MAX_TARGET_ATTEMPTS = 3;

function cleanHeading(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function digestUnsubscribeUrl(subscriptionId: string, email: string): string {
  const url = new URL('/api/v1/report-digests/unsubscribe', resolvePublicUrl());
  url.searchParams.set(
    'token',
    createReportDigestUnsubscribeToken(subscriptionId, email.trim().toLowerCase())
  );
  return url.toString();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "'": '&#39;',
      '"': '&quot;',
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
    };
    return entities[character] ?? character;
  });
}

function unsubscribeHtml(digestHtml: string, unsubscribeUrl: string): string {
  return `${digestHtml}<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-family:Arial,sans-serif"><tr><td style="padding:12px 0;color:#687386;font-size:12px"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#475467">Unsubscribe from this digest</a></td></tr></table>`;
}

async function deliverTarget(
  target: DigestTarget,
  digest: ReturnType<typeof buildReportDigest>,
  subscriptionId: string
): Promise<void> {
  if (target.kind === 'email' && target.email) {
    const unsubscribeUrl = digestUnsubscribeUrl(subscriptionId, target.email);
    await sendReportDigestEmail({
      html: unsubscribeHtml(digest.html, unsubscribeUrl),
      listUnsubscribeUrl: unsubscribeUrl,
      subject: digest.subject,
      text: `${digest.text}\n\nUnsubscribe from this digest: ${unsubscribeUrl}`,
      to: target.email,
    });
    return;
  }
  if (target.kind === 'slack' && target.slackChannelId) {
    await postSlackChannelMessage(target.slackChannelId, digest.slackMrkdwn, digest.slackBlocks);
    return;
  }
  throw new Error('Invalid report digest target');
}

export async function sendReportDigests(input: {
  now?: Date;
  periodStart: Date;
  subscriptionId?: string;
  sendTest?: boolean;
}): Promise<{ failed: number; rollupIncomplete: number; sent: number; skipped: number }> {
  const now = input.now ?? new Date();
  const currentStart = new Date(
    Date.UTC(
      input.periodStart.getUTCFullYear(),
      input.periodStart.getUTCMonth(),
      input.periodStart.getUTCDate()
    )
  );
  const currentEnd = new Date(currentStart.getTime() + 7 * DAY_MS);
  const previousStart = new Date(currentStart.getTime() - 7 * DAY_MS);
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
  let rollupIncomplete = 0;
  let skipped = 0;
  for (const subscription of subscriptions) {
    heartbeat(`processing report digest subscription ${subscription.id}`);
    let stage: 'build' | 'delivery' = 'build';
    try {
      if (!input.sendTest) {
        const lastAllowedStart = subscription.lastPeriodStart
          ? new Date(subscription.lastPeriodStart.getTime() + 6 * DAY_MS)
          : null;
        if (lastAllowedStart && currentStart < lastAllowedStart) {
          await recordDigestError(subscription.id, 'period_too_soon');
          skipped++;
          continue;
        }
        const latestDelivery = await runUnscoped(
          'the report digest prevents delivery periods from moving backwards',
          ['ReportDigestDelivery'],
          () =>
            prisma.reportDigestDelivery.findFirst({
              orderBy: { periodStart: 'desc' },
              select: { periodStart: true },
              where: { subscriptionId: subscription.id },
            })
        );
        if (latestDelivery && currentStart < latestDelivery.periodStart) {
          await recordDigestError(subscription.id, 'period_out_of_order');
          skipped++;
          continue;
        }
      }
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
        if (input.sendTest) {
          await recordTestDigestError(subscription.id, 'rollup_incomplete');
        } else {
          await recordDigestError(subscription.id, 'rollup_incomplete');
        }
        rollupIncomplete++;
        failed++;
        skipped++;
        continue;
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
        if (input.sendTest) {
          await recordTestDigestError(subscription.id, 'build_failed');
        } else {
          await recordDigestError(subscription.id, 'build_failed');
        }
        failed++;
        continue;
      }

      stage = 'delivery';
      const optedOut = new Set(subscription.optedOutEmails.map((email) => email.toLowerCase()));
      const targets: DigestTarget[] = subscription.emailRecipients
        .filter((email) => !optedOut.has(email.trim().toLowerCase()))
        .map((email) => ({
          email: email.trim().toLowerCase(),
          key: `email:${email.trim().toLowerCase()}`,
          kind: 'email',
        }));
      if (subscription.slackChannel) {
        targets.push({
          key: 'slack',
          kind: 'slack',
          slackChannelId: subscription.slackChannel.slackChannelId,
        });
      }
      if (targets.length === 0) {
        skipped++;
        continue;
      }

      if (input.sendTest) {
        let deliveryError: DigestErrorCode | null = null;
        for (const target of targets) {
          try {
            await deliverTarget(target, digest, subscription.id);
          } catch (error) {
            deliveryError ??= target.kind === 'email' ? 'email_failed' : 'slack_failed';
            logWarn('report digest test delivery failed', {
              error: error instanceof Error ? error.message : String(error),
              subscriptionId: subscription.id,
              target: target.key,
            });
          }
        }
        if (deliveryError) {
          await recordTestDigestError(subscription.id, deliveryError);
          failed++;
          continue;
        }
        await clearTestDigestError(subscription.id);
        sent++;
        continue;
      }

      const targetsByKey = new Map(targets.map((target) => [target.key, target]));
      const deliveryScope = ['ReportDigestDelivery', 'ReportDigestSubscription'];
      await runUnscoped(
        'the report digest creates one durable row for each active target',
        deliveryScope,
        () =>
          prisma.reportDigestDelivery.createMany({
            data: targets.map((target) => ({
              periodStart: currentStart,
              status: 'failed',
              subscriptionId: subscription.id,
              target: target.key,
            })),
            skipDuplicates: true,
          })
      );
      const deliveries = await runUnscoped(
        'the report digest loads delivery state for its active targets',
        ['ReportDigestDelivery'],
        () =>
          prisma.reportDigestDelivery.findMany({
            select: { attempts: true, id: true, status: true, target: true },
            where: {
              periodStart: currentStart,
              subscriptionId: subscription.id,
              target: { in: [...targetsByKey.keys()] },
            },
          })
      );
      const deliveredTargets = new Set<string>();
      for (const delivery of deliveries) {
        const target = targetsByKey.get(delivery.target);
        if (!target || delivery.status === 'sent' || delivery.attempts >= MAX_TARGET_ATTEMPTS) {
          continue;
        }
        const claim = await runUnscoped(
          'the report digest claims one target attempt using its observed attempt count',
          ['ReportDigestDelivery'],
          () =>
            prisma.reportDigestDelivery.updateMany({
              data: { attempts: { increment: 1 }, lastError: null },
              where: {
                AND: [
                  { id: delivery.id },
                  { status: 'failed' },
                  { attempts: delivery.attempts },
                  { attempts: { lt: MAX_TARGET_ATTEMPTS } },
                ],
              },
            })
        );
        if (claim.count === 0) {
          continue;
        }
        try {
          await deliverTarget(target, digest, subscription.id);
          await runUnscoped(
            'the report digest records one sent target',
            ['ReportDigestDelivery'],
            () =>
              prisma.reportDigestDelivery.update({
                data: { lastError: null, sentAt: now, status: 'sent' },
                where: { id: delivery.id },
              })
          );
          deliveredTargets.add(target.key);
        } catch (error) {
          const code = target.kind === 'email' ? 'email_failed' : 'slack_failed';
          logWarn('report digest target delivery failed', {
            error: error instanceof Error ? error.message : String(error),
            subscriptionId: subscription.id,
            target: target.key,
          });
          await runUnscoped(
            'the report digest records a failed target attempt',
            ['ReportDigestDelivery'],
            () =>
              prisma.reportDigestDelivery.update({
                data: { lastError: code, status: 'failed' },
                where: { id: delivery.id },
              })
          );
        }
      }
      const completedDeliveries = await runUnscoped(
        'the report digest checks completion for active targets',
        ['ReportDigestDelivery'],
        () =>
          prisma.reportDigestDelivery.findMany({
            select: { sentAt: true, status: true, target: true },
            where: {
              periodStart: currentStart,
              subscriptionId: subscription.id,
              target: { in: [...targetsByKey.keys()] },
            },
          })
      );
      const failedTargets = completedDeliveries.filter((delivery) => delivery.status !== 'sent');
      if (failedTargets.length > 0) {
        const failedTarget = targetsByKey.get(failedTargets[0]?.target ?? '');
        await recordDigestError(
          subscription.id,
          failedTarget?.kind === 'slack' ? 'slack_failed' : 'email_failed'
        );
        failed++;
        continue;
      }
      const latestDeliverySentAt = completedDeliveries.reduce<Date | null>((latest, delivery) => {
        if (delivery.status !== 'sent' || delivery.sentAt === null) {
          return latest;
        }
        return latest === null || delivery.sentAt > latest ? delivery.sentAt : latest;
      }, null);
      await runUnscoped(
        'the report digest records its last fully sent period',
        ['ReportDigestSubscription'],
        () =>
          prisma.reportDigestSubscription.update({
            data: {
              lastError: null,
              lastPeriodStart: currentStart,
              ...(deliveredTargets.size > 0 && latestDeliverySentAt
                ? { lastSentAt: latestDeliverySentAt }
                : {}),
            },
            where: { id: subscription.id },
          })
      );
      sent++;
    } catch (error) {
      logWarn('report digest subscription failed', {
        error: error instanceof Error ? error.message : String(error),
        subscriptionId: subscription.id,
      });
      if (!input.sendTest) {
        await recordDigestError(
          subscription.id,
          stage === 'build' ? 'build_failed' : 'delivery_failed'
        );
      } else {
        await recordTestDigestError(
          subscription.id,
          stage === 'build' ? 'build_failed' : 'delivery_failed'
        );
      }
      failed++;
    } finally {
      heartbeat(`finished report digest subscription ${subscription.id}`);
    }
  }
  return { failed, rollupIncomplete, sent, skipped };
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

async function recordTestDigestError(subscriptionId: string, code: DigestErrorCode): Promise<void> {
  try {
    await runUnscoped(
      'the report digest records send-test failures separately from delivery status',
      ['ReportDigestSubscription'],
      () =>
        prisma.reportDigestSubscription.update({
          data: { lastTestError: code },
          where: { id: subscriptionId },
        })
    );
  } catch (error) {
    logWarn('report digest test status could not be recorded', {
      error: error instanceof Error ? error.message : String(error),
      subscriptionId,
    });
  }
}

async function clearTestDigestError(subscriptionId: string): Promise<void> {
  await runUnscoped(
    'the report digest clears the previous send-test error',
    ['ReportDigestSubscription'],
    () =>
      prisma.reportDigestSubscription.update({
        data: { lastTestError: null },
        where: { id: subscriptionId },
      })
  );
}
