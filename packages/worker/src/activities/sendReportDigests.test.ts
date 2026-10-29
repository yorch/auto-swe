import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emails: [] as string[],
  failEmail: false,
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
    },
    workflowHumanStep: { findMany: async () => [] },
    workflowRunDailyRollup: { findMany: async () => [] },
    workflowStep: { groupBy: async () => [] },
    workflowTemplate: { findMany: async () => [] },
  },
}));
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
    if (mocks.failEmail) {
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
  mocks.slackPosts = [];
  mocks.emails = [];
  mocks.failEmail = false;
});

describe('sendReportDigests', () => {
  it('skips a scheduled subscription sent within six days', async () => {
    mocks.subscriptions = [
      subscription('recent', { lastSentAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000) }),
    ];
    await expect(sendReportDigests({ now })).resolves.toEqual({ failed: 0, sent: 0, skipped: 1 });
    expect(mocks.updates).toHaveLength(0);
  });

  it('send-test ignores the cooldown and leaves lastSentAt unchanged', async () => {
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
    expect(mocks.updates).toHaveLength(0);
  });

  it('records a failed subscription and continues to later subscriptions', async () => {
    mocks.subscriptions = [
      subscription('broken', { emailRecipients: ['broken@example.test'] }),
      subscription('healthy', { slackChannel: { slackChannelId: 'C123' } }),
    ];
    mocks.failEmail = true;
    await expect(sendReportDigests({ now })).resolves.toEqual({ failed: 1, sent: 1, skipped: 0 });
    expect(mocks.updates).toContainEqual({
      data: { lastError: 'SMTP failed' },
      id: 'broken',
    });
    expect(mocks.updates).toContainEqual({
      data: { lastError: null, lastSentAt: now },
      id: 'healthy',
    });
    expect(mocks.slackPosts).toHaveLength(1);
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
