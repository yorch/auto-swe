import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  coverageIncomplete: false,
  deliveries: new Map<
    string,
    {
      attempts: number;
      id: string;
      lastError: string | null;
      periodStart: Date;
      sentAt: Date | null;
      status: string;
      subscriptionId: string;
      target: string;
    }
  >(),
  deliveryPersistenceFails: false,
  emails: [] as Array<{ listUnsubscribeUrl: string; to: string }>,
  failedEmailRecipients: [] as string[],
  gatesAtLimit: false,
  heartbeats: [] as string[],
  latestDeliveryPeriod: null as Date | null,
  nextDeliveryId: 0,
  orgWideReportsEnabled: false,
  slackPosts: [] as Array<{ blocks: unknown[]; channelId: string; text: string }>,
  subscriptions: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ id: string; data: Record<string, unknown> }>,
}));

vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: async () => mocks.orgWideReportsEnabled,
}));
function deliveryKey(subscriptionId: string, periodStart: Date, target: string): string {
  return `${subscriptionId}:${periodStart.toISOString().slice(0, 10)}:${target}`;
}

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    reportDigestDelivery: {
      createMany: async ({
        data,
      }: {
        data: Array<{ periodStart: Date; subscriptionId: string; target: string }>;
      }) => {
        if (mocks.deliveryPersistenceFails) {
          throw new Error('database write failed');
        }
        for (const row of data) {
          const key = deliveryKey(row.subscriptionId, row.periodStart, row.target);
          if (!mocks.deliveries.has(key)) {
            mocks.nextDeliveryId++;
            mocks.deliveries.set(key, {
              attempts: 0,
              id: `delivery-${mocks.nextDeliveryId}`,
              lastError: null,
              periodStart: row.periodStart,
              sentAt: null,
              status: 'failed',
              subscriptionId: row.subscriptionId,
              target: row.target,
            });
          }
        }
        return { count: data.length };
      },
      findFirst: async () =>
        mocks.latestDeliveryPeriod ? { periodStart: mocks.latestDeliveryPeriod } : null,
      findMany: async ({
        where,
      }: {
        where: { periodStart: Date; subscriptionId: string; target: { in: string[] } };
      }) =>
        [...mocks.deliveries.values()]
          .filter(
            (row) =>
              row.subscriptionId === where.subscriptionId &&
              row.periodStart.getTime() === where.periodStart.getTime() &&
              where.target.in.includes(row.target)
          )
          .map(({ attempts, id, sentAt, status, target }) => ({
            attempts,
            id,
            sentAt,
            status,
            target,
          })),
      update: async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const delivery = [...mocks.deliveries.values()].find((row) => row.id === where.id);
        if (!delivery) {
          throw new Error('Missing delivery row');
        }
        Object.assign(delivery, data);
        return delivery;
      },
      updateMany: async ({
        data,
        where,
      }: {
        data: { attempts: { increment: number } };
        where: { AND: Array<Record<string, unknown>> };
      }) => {
        const conditions = where.AND;
        const id = conditions.find((condition) => 'id' in condition)?.id;
        const expectedAttempts = conditions.find((condition) => 'attempts' in condition)?.attempts;
        const delivery = [...mocks.deliveries.values()].find((row) => row.id === id);
        if (
          delivery?.status !== 'failed' ||
          delivery.attempts !== expectedAttempts ||
          delivery.attempts >= 3
        ) {
          return { count: 0 };
        }
        delivery.attempts += data.attempts.increment;
        delivery.lastError = null;
        return { count: 1 };
      },
    },
    reportDigestSubscription: {
      findMany: async () => mocks.subscriptions,
      update: async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        mocks.updates.push({ data, id: where.id });
      },
    },
    workflowHumanStep: { count: async () => 0, findFirst: async () => null },
    workflowRunDailyRollup: {
      findMany: async () => [],
      groupBy: async () =>
        Array.from({ length: mocks.coverageIncomplete ? 13 : 14 }, (_, index) => ({
          day: new Date(Date.UTC(2026, 9, 5 + index)),
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
  resolvePublicUrl: () => 'https://gateway.example.test',
  resolveWebUrl: () => 'https://dashboard.example.test',
}));
vi.mock('@auto-swe/shared/lib/reportDigestUnsubscribe', () => ({
  createReportDigestUnsubscribeToken: (id: string, email: string) => `${id}.${email}.signed`,
}));
vi.mock('@auto-swe/shared/lib/billing', () => ({
  orgMonthSpend: async () => ({ totalUsd: 0 }),
}));
vi.mock('@auto-swe/shared/lib/budgetForecast', () => ({
  forecastMonthlyBudget: () => ({ projectedUsd: 0, status: 'within_budget' }),
}));
vi.mock('../lib/slackNotify.js', () => ({
  postSlackChannelMessage: async (channelId: string, text: string, blocks: unknown[] = []) => {
    mocks.slackPosts.push({ blocks, channelId, text });
  },
}));
vi.mock('../lib/reportDigestEmail.js', () => ({
  sendReportDigestEmail: async ({
    listUnsubscribeUrl,
    to,
  }: {
    listUnsubscribeUrl: string;
    to: string;
  }) => {
    mocks.emails.push({ listUnsubscribeUrl, to });
    if (mocks.failedEmailRecipients.includes(to)) {
      throw new Error('SMTP failed');
    }
  },
}));

import { logWarn } from '../lib/activityLog.js';
import { sendReportDigests } from './sendReportDigests.js';

const now = new Date('2026-10-20T12:00:00Z');
const periodStart = new Date(Date.UTC(2026, 9, 12));
const baseInput = {
  now: now.toISOString(),
  periodStart: periodStart.toISOString().slice(0, 10),
};

function subscription(id: string, overrides: Record<string, unknown> = {}) {
  return {
    createdAt: now,
    emailRecipients: [],
    enabled: true,
    id,
    lastError: null,
    lastPeriodStart: null,
    lastSentAt: null,
    optedOutEmails: [],
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
  mocks.deliveries.clear();
  mocks.nextDeliveryId = 0;
  mocks.latestDeliveryPeriod = null;
  mocks.coverageIncomplete = false;
  mocks.deliveryPersistenceFails = false;
  mocks.gatesAtLimit = false;
  mocks.heartbeats = [];
  mocks.slackPosts = [];
  mocks.emails = [];
  mocks.failedEmailRecipients = [];
  mocks.orgWideReportsEnabled = false;
});

describe('sendReportDigests', () => {
  it.each([undefined, '2026-10-20', '2026-02-30', '2026-10-19T01:00:00.000Z'])(
    'rejects invalid periodStart %s',
    async (periodStart) => {
      await expect(sendReportDigests({ ...baseInput, periodStart })).rejects.toThrow(
        'valid UTC midnight on a Monday'
      );
    }
  );

  it('rejects a non-canonical now timestamp', async () => {
    await expect(sendReportDigests({ ...baseInput, now: '2026-10-20T12:00:00Z' })).rejects.toThrow(
      'now must be a canonical UTC timestamp'
    );
  });

  it('skips disabled organization digests without creating deliveries', async () => {
    mocks.subscriptions = [
      subscription('disabled-org', {
        organization: { id: 'org-1' },
        orgId: 'org-1',
        scope: 'ORGANIZATION',
        team: null,
        teamId: null,
      }),
    ];
    await expect(sendReportDigests({ now, periodStart })).resolves.toMatchObject({ skipped: 1 });
    expect(mocks.deliveries.size).toBe(0);
    expect(logWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'org_wide_reports_disabled' })
    );
  });
  it('persists each target once and does not resend a sent target for the same period', async () => {
    mocks.subscriptions = [
      subscription('idempotent', { emailRecipients: ['digest@example.test'] }),
    ];
    await expect(sendReportDigests(baseInput)).resolves.toEqual({
      failed: 0,
      rollupIncomplete: 0,
      sent: 1,
      skipped: 0,
    });
    const retryNow = new Date(now.getTime() + 15 * 60 * 1000);
    await expect(sendReportDigests({ ...baseInput, now: retryNow.toISOString() })).resolves.toEqual(
      {
        failed: 0,
        rollupIncomplete: 0,
        sent: 1,
        skipped: 0,
      }
    );
    expect(mocks.emails.map(({ to }) => to)).toEqual(['digest@example.test']);
    expect(
      mocks.deliveries.get(deliveryKey('idempotent', periodStart, 'email:digest@example.test'))
    ).toMatchObject({ attempts: 1, status: 'sent' });
    expect(mocks.updates).toContainEqual({
      data: { lastError: null, lastPeriodStart: periodStart, lastSentAt: now },
      id: 'idempotent',
    });
    expect(mocks.updates.filter(({ data }) => 'lastSentAt' in data)).toHaveLength(1);
    expect(mocks.updates.at(-1)).toEqual({
      data: { lastError: null, lastPeriodStart: periodStart },
      id: 'idempotent',
    });
  });

  it('uses the latest delivery sentAt and leaves it unchanged on a no-op retry', async () => {
    mocks.subscriptions = [
      subscription('latest-sent-at', {
        emailRecipients: ['first@example.test', 'second@example.test'],
      }),
    ];
    mocks.failedEmailRecipients = ['second@example.test'];
    const laterSentAt = new Date('2026-10-20T12:15:00Z');
    const earlierRetryAt = new Date('2026-10-20T12:10:00Z');

    await expect(
      sendReportDigests({ ...baseInput, now: laterSentAt.toISOString() })
    ).resolves.toMatchObject({ failed: 1, sent: 0 });
    mocks.failedEmailRecipients = [];
    await expect(
      sendReportDigests({ ...baseInput, now: earlierRetryAt.toISOString() })
    ).resolves.toMatchObject({ failed: 0, sent: 1 });

    expect(mocks.updates).toContainEqual({
      data: { lastError: null, lastPeriodStart: periodStart, lastSentAt: laterSentAt },
      id: 'latest-sent-at',
    });
    mocks.updates = [];

    await expect(
      sendReportDigests({
        ...baseInput,
        now: new Date('2026-10-20T12:30:00Z').toISOString(),
      })
    ).resolves.toMatchObject({ failed: 0, sent: 1 });
    expect(mocks.updates.at(-1)).toEqual({
      data: { lastError: null, lastPeriodStart: periodStart },
      id: 'latest-sent-at',
    });
  });

  it('retries only failed targets and stops after three attempts', async () => {
    mocks.subscriptions = [
      subscription('partial', {
        emailRecipients: ['first@example.test', 'second@example.test', 'third@example.test'],
      }),
    ];
    mocks.failedEmailRecipients = ['second@example.test'];
    await expect(sendReportDigests(baseInput)).resolves.toEqual({
      failed: 1,
      rollupIncomplete: 0,
      sent: 0,
      skipped: 0,
    });
    mocks.failedEmailRecipients = [];
    await expect(sendReportDigests(baseInput)).resolves.toEqual({
      failed: 0,
      rollupIncomplete: 0,
      sent: 1,
      skipped: 0,
    });
    expect(mocks.emails.map(({ to }) => to)).toEqual([
      'first@example.test',
      'second@example.test',
      'third@example.test',
      'second@example.test',
    ]);
    expect(
      mocks.deliveries.get(deliveryKey('partial', periodStart, 'email:second@example.test'))
    ).toMatchObject({ attempts: 2, status: 'sent' });

    mocks.subscriptions = [subscription('bounded', { emailRecipients: ['fail@example.test'] })];
    mocks.failedEmailRecipients = ['fail@example.test'];
    for (let attempt = 0; attempt < 4; attempt++) {
      await sendReportDigests(baseInput);
    }
    expect(mocks.emails.filter(({ to }) => to === 'fail@example.test')).toHaveLength(3);
    expect(
      mocks.deliveries.get(deliveryKey('bounded', periodStart, 'email:fail@example.test'))
    ).toMatchObject({ attempts: 3, status: 'failed' });
  });

  it('excludes opted-out addresses and adds a recipient-specific unsubscribe header URL', async () => {
    mocks.subscriptions = [
      subscription('opt-out', {
        emailRecipients: ['keep@example.test', 'other@example.test', 'stop@example.test'],
        optedOutEmails: ['stop@example.test'],
        slackChannel: { slackChannelId: 'C123' },
      }),
    ];
    await expect(sendReportDigests(baseInput)).resolves.toMatchObject({ sent: 1 });
    expect(mocks.emails.map(({ to }) => to)).toEqual(['keep@example.test', 'other@example.test']);
    const unsubscribeUrl = new URL(mocks.emails[0]?.listUnsubscribeUrl ?? '');
    expect(unsubscribeUrl.origin).toBe('https://gateway.example.test');
    expect(unsubscribeUrl.pathname).toBe('/api/v1/report-digests/unsubscribe');
    expect(unsubscribeUrl.searchParams.get('token')).toBe('opt-out.keep@example.test.signed');
    expect(new URL(mocks.emails[1]?.listUnsubscribeUrl ?? '').searchParams.get('token')).toBe(
      'opt-out.other@example.test.signed'
    );
    expect(mocks.slackPosts[0]?.blocks).toContainEqual(
      expect.objectContaining({
        elements: [
          expect.objectContaining({ url: 'https://dashboard.example.test/admin/reports' }),
        ],
        type: 'actions',
      })
    );
  });

  it('send-test bypasses delivery persistence and leaves lastSentAt unchanged', async () => {
    mocks.subscriptions = [
      subscription('test-send', {
        lastSentAt: new Date(now.getTime() - 60_000),
        slackChannel: { slackChannelId: 'C123' },
      }),
    ];
    await expect(
      sendReportDigests({ ...baseInput, sendTest: true, subscriptionId: 'test-send' })
    ).resolves.toEqual({ failed: 0, rollupIncomplete: 0, sent: 1, skipped: 0 });
    expect(mocks.slackPosts).toHaveLength(1);
    expect(mocks.slackPosts[0]?.blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'header' })])
    );
    expect(mocks.deliveries.size).toBe(0);
    expect(mocks.updates).toEqual([{ data: { lastTestError: null }, id: 'test-send' }]);
  });

  it('records send-test failures without changing scheduled delivery status', async () => {
    mocks.subscriptions = [
      subscription('test-failure', {
        emailRecipients: ['fail@example.test'],
        lastError: 'email_failed',
      }),
    ];
    mocks.failedEmailRecipients = ['fail@example.test'];

    await expect(
      sendReportDigests({
        ...baseInput,
        sendTest: true,
        subscriptionId: 'test-failure',
      })
    ).resolves.toMatchObject({ failed: 1 });

    expect(mocks.updates).toContainEqual({
      data: { lastTestError: 'email_failed' },
      id: 'test-failure',
    });
    expect(mocks.updates).not.toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ lastError: expect.anything() }) })
    );
  });

  it('records failures and continues to later subscriptions', async () => {
    mocks.subscriptions = [
      subscription('broken', { emailRecipients: ['broken@example.test'] }),
      subscription('healthy', { slackChannel: { slackChannelId: 'C123' } }),
    ];
    mocks.failedEmailRecipients = ['broken@example.test'];
    await expect(sendReportDigests(baseInput)).resolves.toEqual({
      failed: 1,
      rollupIncomplete: 0,
      sent: 1,
      skipped: 0,
    });
    expect(mocks.updates).toContainEqual({
      data: { lastError: 'email_failed' },
      id: 'broken',
    });
    expect(mocks.updates).toContainEqual({
      data: { lastError: null, lastPeriodStart: periodStart, lastSentAt: now },
      id: 'healthy',
    });
    expect(mocks.slackPosts).toHaveLength(1);
    expect(mocks.heartbeats).toHaveLength(4);
  });

  it('skips an uncovered day without creating delivery rows', async () => {
    mocks.subscriptions = [subscription('uncovered', { slackChannel: { slackChannelId: 'C123' } })];
    mocks.coverageIncomplete = true;
    await expect(sendReportDigests(baseInput)).resolves.toEqual({
      failed: 1,
      rollupIncomplete: 1,
      sent: 0,
      skipped: 1,
    });
    expect(mocks.deliveries.size).toBe(0);
    expect(mocks.updates).toContainEqual({
      data: { lastError: 'rollup_incomplete' },
      id: 'uncovered',
    });
  });

  it('bounds gate reads and includes a text fallback for Slack', async () => {
    mocks.subscriptions = [
      subscription('gate-limit', { slackChannel: { slackChannelId: 'C123' } }),
    ];
    mocks.gatesAtLimit = true;
    await sendReportDigests(baseInput);
    expect(mocks.slackPosts[0]?.text).toContain('Worst gate: not computed');
    expect(mocks.slackPosts[0]?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'header' }),
        expect.objectContaining({ type: 'section' }),
        expect.objectContaining({ type: 'context' }),
        expect.objectContaining({ type: 'actions' }),
      ])
    );
  });

  it('does not deliver within six days of the last completed period', async () => {
    mocks.subscriptions = [
      subscription('recent', {
        emailRecipients: ['digest@example.test'],
        lastPeriodStart: new Date('2026-10-12T00:00:00Z'),
      }),
    ];

    await expect(sendReportDigests(baseInput)).resolves.toEqual({
      failed: 0,
      rollupIncomplete: 0,
      sent: 0,
      skipped: 1,
    });

    expect(mocks.deliveries.size).toBe(0);
    expect(mocks.emails).toHaveLength(0);
  });

  it('does not create a delivery for a period older than existing delivery history', async () => {
    mocks.subscriptions = [subscription('stale', { emailRecipients: ['digest@example.test'] })];
    mocks.latestDeliveryPeriod = new Date('2026-10-20T00:00:00Z');

    await expect(sendReportDigests(baseInput)).resolves.toEqual({
      failed: 0,
      rollupIncomplete: 0,
      sent: 0,
      skipped: 1,
    });

    expect(mocks.deliveries.size).toBe(0);
    expect(mocks.emails).toHaveLength(0);
  });

  it('classifies delivery persistence exceptions separately from digest build failures', async () => {
    mocks.subscriptions = [
      subscription('delivery-write-failure', { emailRecipients: ['digest@example.test'] }),
    ];
    mocks.deliveryPersistenceFails = true;

    await expect(sendReportDigests(baseInput)).resolves.toEqual({
      failed: 1,
      rollupIncomplete: 0,
      sent: 0,
      skipped: 0,
    });

    expect(mocks.updates).toContainEqual({
      data: { lastError: 'delivery_failed' },
      id: 'delivery-write-failure',
    });
  });
});
