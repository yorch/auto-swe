import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimedPeriods: new Map<string, Date>(),
  claims: [] as Array<{ id: string; periodStart: Date }>,
  coverageIncomplete: false,
  emails: [] as string[],
  failedEmailRecipients: [] as string[],
  gatesAtLimit: false,
  heartbeats: [] as string[],
  slackPosts: [] as Array<{ channelId: string; text: string }>,
  subscriptions: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ id: string; data: Record<string, unknown> }>,
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    reportDigestSubscription: {
      findMany: async () => mocks.subscriptions,
      update: async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        mocks.updates.push({ data, id: where.id });
      },
      updateMany: async ({
        data,
        where,
      }: {
        data: { lastPeriodStart: Date };
        where: { id: string };
      }) => {
        const existing = mocks.claimedPeriods.get(where.id);
        if (existing && existing >= data.lastPeriodStart) {
          return { count: 0 };
        }
        mocks.claimedPeriods.set(where.id, data.lastPeriodStart);
        mocks.claims.push({ id: where.id, periodStart: data.lastPeriodStart });
        return { count: 1 };
      },
    },
    workflowHumanStep: { count: async () => 0, findFirst: async () => null },
    workflowRunDailyRollup: {
      findMany: async () => [],
      groupBy: async () =>
        Array.from({ length: mocks.coverageIncomplete ? 13 : 14 }, (_, index) => ({
          day: new Date(Date.UTC(2026, 9, 6 + index)),
        })),
    },
    workflowStep: {
      groupBy: async () =>
        mocks.gatesAtLimit
          ? Array.from({ length: 50_000 }, () => ({
              runId: null,
              status: 'PASSED',
              stepName: null,
            }))
          : [],
    },
    workflowTemplate: { findMany: async () => [] },
  },
}));
vi.mock('@temporalio/activity', () => ({
  heartbeat: (details: string) => mocks.heartbeats.push(details),
}));
vi.mock('../lib/activityLog.js', () => ({ logWarn: vi.fn() }));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_reason: string, _tables: string[], callback: () => unknown) => callback(),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWebUrl: () => 'https://example.test',
}));
vi.mock('@auto-swe/shared/lib/billing', () => ({
  orgMonthSpend: async () => ({ totalUsd: 0 }),
}));
vi.mock('@auto-swe/shared/lib/budgetForecast', () => ({
  forecastMonthlyBudget: () => ({ projectedUsd: 0, status: 'within_budget' }),
}));
vi.mock('../lib/slackNotify.js', () => ({
  postSlackChannelMessage: async (channelId: string, text: string) => {
    mocks.slackPosts.push({ channelId, text });
  },
}));
vi.mock('../lib/reportDigestEmail.js', () => ({
  sendReportDigestEmail: async ({ to }: { to: string }) => {
    mocks.emails.push(to);
    if (mocks.failedEmailRecipients.includes(to)) {
      throw new Error('SMTP failed');
    }
  },
}));

import { sendReportDigests } from './sendReportDigests.js';

const now = new Date('2026-10-20T12:00:00Z');

function subscription(id: string, overrides: Record<string, unknown> = {}) {
  return {
    createdAt: now,
    emailRecipients: [],
    enabled: true,
    id,
    lastError: null,
    lastPeriodStart: null,
    lastSentAt: null,
    organization: null,
    orgId: null,
    scope: 'TEAM',
    slackChannel: null,
    team: { id: 'team-1', name: 'Team', organization: null, orgId: 'org-1' },
    teamId: 'team-1',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.subscriptions = [];
  mocks.updates = [];
  mocks.claims = [];
  mocks.claimedPeriods.clear();
  mocks.coverageIncomplete = false;
  mocks.gatesAtLimit = false;
  mocks.heartbeats = [];
  mocks.slackPosts = [];
  mocks.emails = [];
  mocks.failedEmailRecipients = [];
});

describe('sendReportDigests', () => {
  it('skips a subscription already claimed for the same reporting period', async () => {
    mocks.subscriptions = [
      subscription('recent', { lastPeriodStart: new Date(Date.UTC(2026, 9, 13)) }),
    ];
    mocks.claimedPeriods.set('recent', new Date(Date.UTC(2026, 9, 13)));
    await expect(sendReportDigests({ now })).resolves.toEqual({ failed: 0, sent: 0, skipped: 1 });
    expect(mocks.claims).toHaveLength(0);
  });

  it('send-test bypasses the weekly claim and leaves lastSentAt unchanged', async () => {
    mocks.subscriptions = [
      subscription('test-send', {
        lastSentAt: new Date(now.getTime() - 60_000),
        slackChannel: { slackChannelId: 'C123' },
      }),
    ];
    await expect(
      sendReportDigests({ now, sendTest: true, subscriptionId: 'test-send' })
    ).resolves.toEqual({ failed: 0, sent: 1, skipped: 0 });
    expect(mocks.slackPosts).toHaveLength(1);
    expect(mocks.claims).toHaveLength(0);
    expect(mocks.updates).toEqual([{ data: { lastError: null }, id: 'test-send' }]);
  });

  it('records a failed subscription and continues to later subscriptions', async () => {
    mocks.subscriptions = [
      subscription('broken', { emailRecipients: ['broken@example.test'] }),
      subscription('healthy', { slackChannel: { slackChannelId: 'C123' } }),
    ];
    mocks.failedEmailRecipients = ['broken@example.test'];
    await expect(sendReportDigests({ now })).resolves.toEqual({ failed: 1, sent: 1, skipped: 0 });
    expect(mocks.updates).toContainEqual({
      data: { lastError: 'email_failed' },
      id: 'broken',
    });
    expect(mocks.updates).toContainEqual({
      data: { lastError: null, lastSentAt: now },
      id: 'healthy',
    });
    expect(mocks.slackPosts).toHaveLength(1);
    expect(mocks.heartbeats).toHaveLength(4);
  });

  it('does not resend to any recipient after a partial failure in the same period', async () => {
    mocks.subscriptions = [
      subscription('partial', {
        emailRecipients: ['first@example.test', 'second@example.test', 'third@example.test'],
      }),
    ];
    mocks.failedEmailRecipients = ['second@example.test'];
    await expect(sendReportDigests({ now })).resolves.toEqual({
      failed: 1,
      sent: 0,
      skipped: 0,
    });
    await expect(sendReportDigests({ now })).resolves.toEqual({
      failed: 0,
      sent: 0,
      skipped: 1,
    });
    expect(mocks.emails).toEqual(['first@example.test', 'second@example.test']);
    expect(mocks.updates).toContainEqual({
      data: { lastError: 'email_failed' },
      id: 'partial',
    });
  });

  it('skips an uncovered day without claiming the reporting period', async () => {
    mocks.subscriptions = [subscription('uncovered', { slackChannel: { slackChannelId: 'C123' } })];
    mocks.coverageIncomplete = true;
    await expect(sendReportDigests({ now })).resolves.toEqual({
      failed: 0,
      sent: 0,
      skipped: 1,
    });
    expect(mocks.claims).toHaveLength(0);
    expect(mocks.updates).toContainEqual({
      data: { lastError: 'rollup_incomplete' },
      id: 'uncovered',
    });
  });

  it('bounds gate reads and reports the worst gate as not computed at the limit', async () => {
    mocks.subscriptions = [
      subscription('gate-limit', { slackChannel: { slackChannelId: 'C123' } }),
    ];
    mocks.gatesAtLimit = true;
    await sendReportDigests({ now });
    expect(mocks.slackPosts[0]?.text).toContain('Worst gate: not computed');
  });

  it('delivers to email-only subscriptions', async () => {
    mocks.subscriptions = [
      subscription('email-only', { emailRecipients: ['digest@example.test'] }),
    ];
    await expect(sendReportDigests({ now })).resolves.toMatchObject({ sent: 1 });
    expect(mocks.emails).toEqual(['digest@example.test']);
  });

  it('delivers to Slack-only subscriptions', async () => {
    mocks.subscriptions = [
      subscription('slack-only', { slackChannel: { slackChannelId: 'C123' } }),
    ];
    await expect(sendReportDigests({ now })).resolves.toMatchObject({ sent: 1 });
    expect(mocks.slackPosts.map(({ channelId }) => channelId)).toEqual(['C123']);
  });
});
