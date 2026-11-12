import { Prisma } from '@auto-swe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    team: { findUnique: vi.fn() },
    teamBudgetNotice: { create: vi.fn(), delete: vi.fn() },
  },
}));
const tokenMock = vi.fn();
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveSlackBotTokenForSlackChannel: (...a: unknown[]) => tokenMock(...a),
  resolveWebUrl: () => 'https://app.example',
}));
const postMock = vi.fn();
vi.mock('./slackNotify.js', () => ({
  postSlackChannelMessage: (...a: unknown[]) => postMock(...a),
}));
const logWarnMock = vi.fn();
vi.mock('./activityLog.js', () => ({ logWarn: (...a: unknown[]) => logWarnMock(...a) }));

import { prisma } from '@auto-swe/shared/db';
import {
  budgetPeriod,
  dueTeamBudgetLevel,
  evaluateTeamBudgetNotice,
  isPermanentSlackPostError,
} from './teamBudgetNotice.js';

const findTeam = vi.mocked(prisma.team.findUnique);
const createNotice = vi.mocked(prisma.teamBudgetNotice.create);
const deleteNotice = vi.mocked(prisma.teamBudgetNotice.delete);

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('dup', { clientVersion: 'x', code: 'P2002' });

describe('dueTeamBudgetLevel', () => {
  const base = { capCents: 1000, thresholdPercent: 80 };
  it('is null below the threshold', () => {
    expect(dueTeamBudgetLevel({ ...base, spentCents: 799 })).toBeNull();
  });
  it('is WARNING at the threshold and above it', () => {
    expect(dueTeamBudgetLevel({ ...base, spentCents: 800 })).toBe('WARNING');
    expect(dueTeamBudgetLevel({ ...base, spentCents: 999 })).toBe('WARNING');
  });
  it('is CAP_REACHED at and above the cap', () => {
    expect(dueTeamBudgetLevel({ ...base, spentCents: 1000 })).toBe('CAP_REACHED');
    expect(dueTeamBudgetLevel({ ...base, spentCents: 5000 })).toBe('CAP_REACHED');
  });
  it('treats a cap of 0 as reached with nothing spent', () => {
    expect(dueTeamBudgetLevel({ capCents: 0, spentCents: 0, thresholdPercent: 80 })).toBe(
      'CAP_REACHED'
    );
  });
  it('has no warning without a threshold, but still reports the cap', () => {
    expect(
      dueTeamBudgetLevel({ capCents: 1000, spentCents: 900, thresholdPercent: null })
    ).toBeNull();
    expect(dueTeamBudgetLevel({ capCents: 1000, spentCents: 1000, thresholdPercent: null })).toBe(
      'CAP_REACHED'
    );
  });
  it('is null without a cap', () => {
    expect(
      dueTeamBudgetLevel({ capCents: null, spentCents: 99999, thresholdPercent: 50 })
    ).toBeNull();
  });
});

describe('budgetPeriod', () => {
  it('is the UTC month and rolls over at the UTC boundary', () => {
    expect(budgetPeriod(new Date('2026-11-30T23:59:59Z'))).toBe('2026-11');
    expect(budgetPeriod(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12');
  });
});

describe('evaluateTeamBudgetNotice', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  beforeEach(() => {
    vi.clearAllMocks();
    findTeam.mockResolvedValue({
      budgetAlertThresholdPercent: 80,
      monthlyBudgetUsdCents: 1000,
      name: 'Pay <!channel> & co',
      slackNotifyChannel: 'C123',
      slug: 'pay',
    } as never);
    tokenMock.mockResolvedValue('xoxb');
    createNotice.mockResolvedValue({} as never);
    deleteNotice.mockResolvedValue({} as never);
    postMock.mockResolvedValue(undefined);
  });

  it('sends nothing below the threshold', async () => {
    await evaluateTeamBudgetNotice('t1', 7.99, now);
    expect(createNotice).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('claims and posts one escaped warning with the figures and a budget link', async () => {
    await evaluateTeamBudgetNotice('t1', 8, now);
    expect(createNotice).toHaveBeenCalledWith({
      data: { level: 'WARNING', period: '2026-11', teamId: 't1' },
    });
    expect(postMock).toHaveBeenCalledTimes(1);
    const [channel, text] = postMock.mock.calls[0] as [string, string];
    expect(channel).toBe('C123');
    expect(text).toContain('Pay &lt;!channel&gt; &amp; co');
    expect(text).not.toContain('<!channel>');
    expect(text).toContain('80% used, $8.00 of $10.00');
    expect(text).toContain('2026-11');
    expect(text).toContain('https://app.example/teams/pay/settings');
  });

  it('posts the cap notice when the cap is reached', async () => {
    await evaluateTeamBudgetNotice('t1', 10, now);
    expect(createNotice).toHaveBeenCalledWith({
      data: { level: 'CAP_REACHED', period: '2026-11', teamId: 't1' },
    });
    expect(postMock.mock.calls[0]?.[1]).toContain('blocked');
  });

  it('sends nothing when another evaluation already holds the marker', async () => {
    createNotice.mockRejectedValue(uniqueViolation());
    await evaluateTeamBudgetNotice('t1', 8, now);
    expect(postMock).not.toHaveBeenCalled();
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it('sends exactly once across concurrent evaluations', async () => {
    let claimed = false;
    createNotice.mockImplementation((async () => {
      if (claimed) {
        throw uniqueViolation();
      }
      claimed = true;
      return {};
    }) as never);
    await Promise.all([1, 2, 3, 4].map(() => evaluateTeamBudgetNotice('t1', 8, now)));
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('sends again in a new month', async () => {
    const seen = new Set<string>();
    createNotice.mockImplementation((async ({ data }: { data: { period: string } }) => {
      if (seen.has(data.period)) {
        throw uniqueViolation();
      }
      seen.add(data.period);
      return {};
    }) as never);
    await evaluateTeamBudgetNotice('t1', 8, now);
    await evaluateTeamBudgetNotice('t1', 8, now);
    await evaluateTeamBudgetNotice('t1', 8, new Date('2026-12-02T00:00:00Z'));
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it('does not claim without a channel or a bot token', async () => {
    findTeam.mockResolvedValue({
      budgetAlertThresholdPercent: 80,
      monthlyBudgetUsdCents: 1000,
      name: 'x',
      slackNotifyChannel: null,
      slug: 'x',
    } as never);
    await evaluateTeamBudgetNotice('t1', 8, now);
    expect(createNotice).not.toHaveBeenCalled();
    findTeam.mockResolvedValue({
      budgetAlertThresholdPercent: 80,
      monthlyBudgetUsdCents: 1000,
      name: 'x',
      slackNotifyChannel: 'C1',
      slug: 'x',
    } as never);
    tokenMock.mockResolvedValue(null);
    await evaluateTeamBudgetNotice('t1', 8, now);
    expect(createNotice).not.toHaveBeenCalled();
  });

  it('swallows a post failure, releases the marker and logs', async () => {
    postMock.mockRejectedValue(new Error('slack down'));
    await expect(evaluateTeamBudgetNotice('t1', 8, now)).resolves.toBeUndefined();
    expect(deleteNotice).toHaveBeenCalledWith({
      where: { teamId_period_level: { level: 'WARNING', period: '2026-11', teamId: 't1' } },
    });
    expect(logWarnMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'channel_not_found',
    'not_in_channel',
    'is_archived',
    'invalid_auth',
    'account_inactive',
  ])('keeps the claim and logs once on a permanent Slack error (%s)', async (code) => {
    postMock.mockRejectedValue(
      new Error(`postSlackChannelMessage: chat.postMessage failed: ${code}`)
    );
    await expect(evaluateTeamBudgetNotice('t1', 8, now)).resolves.toBeUndefined();
    expect(deleteNotice).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'postSlackChannelMessage: chat.postMessage failed: ratelimited',
    'postSlackChannelMessage: chat.postMessage failed: service_unavailable',
    'fetch failed',
    'The operation was aborted',
  ])('releases the claim on a transient failure (%s)', async (message) => {
    postMock.mockRejectedValue(new Error(message));
    await evaluateTeamBudgetNotice('t1', 8, now);
    expect(deleteNotice).toHaveBeenCalledTimes(1);
  });

  it('classifies only the listed Slack codes as permanent', () => {
    const err = (code: string) => new Error(`x: chat.postMessage failed: ${code}`);
    expect(isPermanentSlackPostError(err('is_archived'))).toBe(true);
    expect(isPermanentSlackPostError(err('ratelimited'))).toBe(false);
    expect(isPermanentSlackPostError('boom')).toBe(false);
  });

  it('swallows a database failure', async () => {
    findTeam.mockRejectedValue(new Error('db down'));
    await expect(evaluateTeamBudgetNotice('t1', 8, now)).resolves.toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });
});
