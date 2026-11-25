import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn() },
  team: { findUnique: vi.fn() },
}));
const slack = vi.hoisted(() => ({ post: vi.fn(), token: vi.fn() }));
const warn = vi.hoisted(() => vi.fn());

vi.mock('@auto-swe/shared/db', () => ({ prisma: db }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveSlackBotTokenForSlackChannel: slack.token,
  resolveWebUrl: () => 'https://dash.example.com/',
}));
vi.mock('./slackNotify.js', () => ({ postSlackChannelMessage: slack.post }));
vi.mock('./activityLog.js', () => ({ logWarn: warn }));

import { notifyCampaignStale, staleNoticeText } from './campaignStaleNotice.js';

const CAMPAIGN = '33333333-3333-4333-8333-333333333333';
const NOW = 1_700_000_000_000 + 3 * 86_400_000;

beforeEach(() => {
  vi.resetAllMocks();
  db.campaign.findUnique.mockResolvedValue({
    name: 'Bump lodash',
    orgId: 'org',
    ownerTeamId: 'team-1',
    staleAfterDays: 14,
  });
  db.team.findUnique.mockResolvedValue({ slackNotifyChannel: 'C123' });
  slack.token.mockResolvedValue('xoxb-token');
  slack.post.mockResolvedValue(undefined);
});

const input = {
  campaignId: CAMPAIGN,
  now: NOW,
  targets: [{ repoLabel: 'acme/api', staleSince: 1_700_000_000_000 }],
};

describe('staleNoticeText', () => {
  it('names the campaign, the repository, the days and the campaign page', () => {
    const text = staleNoticeText({
      campaignId: CAMPAIGN,
      campaignName: 'Bump lodash',
      now: NOW,
      repoLabel: 'acme/api',
      staleAfterDays: 14,
      staleSince: 1_700_000_000_000,
    });
    expect(text).toContain('*Bump lodash*');
    expect(text).toContain('acme/api');
    expect(text).toContain('past the 14-day limit');
    expect(text).toContain('stale for 3 days');
    expect(text).toContain(`https://dash.example.com/campaigns/${CAMPAIGN}`);
  });

  it('escapes a campaign name that tries to markup or broadcast', () => {
    const text = staleNoticeText({
      campaignId: CAMPAIGN,
      campaignName: '<!channel> <https://evil|click>',
      now: NOW,
      repoLabel: 'a/b',
      staleAfterDays: null,
      staleSince: NOW,
    });
    expect(text).not.toContain('<!channel>');
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).not.toContain('<https://evil');
  });
});

describe('notifyCampaignStale', () => {
  it('posts one message per target to the owning team’s notification channel', async () => {
    await notifyCampaignStale(input);
    expect(db.team.findUnique).toHaveBeenCalledWith({
      select: { slackNotifyChannel: true },
      where: { id: 'team-1' },
    });
    expect(slack.post).toHaveBeenCalledTimes(1);
    expect(slack.post.mock.calls[0]?.[0]).toBe('C123');
    expect(slack.post.mock.calls[0]?.[1]).toContain('acme/api');
  });

  it('does nothing when the team has no channel or no bot token resolves', async () => {
    db.team.findUnique.mockResolvedValue({ slackNotifyChannel: null });
    await notifyCampaignStale(input);
    db.team.findUnique.mockResolvedValue({ slackNotifyChannel: 'C123' });
    slack.token.mockResolvedValue(null);
    await notifyCampaignStale(input);
    expect(slack.post).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws, logs a failed post without the repository or the campaign name, and carries on', async () => {
    slack.post.mockRejectedValue(new Error('chat.postMessage failed: channel_not_found'));
    await expect(
      notifyCampaignStale({
        ...input,
        targets: [
          { repoLabel: 'acme/secret-repo', staleSince: NOW },
          { repoLabel: 'acme/other', staleSince: NOW },
        ],
      })
    ).resolves.toBeUndefined();
    expect(slack.post).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('acme/');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Bump lodash');
    db.campaign.findUnique.mockRejectedValue(new Error('db down'));
    await expect(notifyCampaignStale(input)).resolves.toBeUndefined();
  });
});
