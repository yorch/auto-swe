import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn() },
  connectionTeamShare: { findMany: vi.fn() },
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

import { notifyCampaignStale, staleDigestText } from './campaignStaleNotice.js';

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
  db.connectionTeamShare.findMany.mockResolvedValue([]);
});

const OWN = 'team-1';
const target = (repoLabel: string, over: Record<string, unknown> = {}) => ({
  connectionId: `conn-${repoLabel}`,
  repoLabel,
  staleSince: 1_700_000_000_000,
  teamId: OWN,
  ...over,
});
const input = { campaignId: CAMPAIGN, now: NOW, targets: [target('acme/api')] };

const digest = (over: Partial<Parameters<typeof staleDigestText>[0]> = {}) =>
  staleDigestText({
    campaignId: CAMPAIGN,
    campaignName: 'Bump lodash',
    named: [{ repoLabel: 'acme/api', staleSince: 1_700_000_000_000 }],
    now: NOW,
    otherTeamCount: 0,
    staleAfterDays: 14,
    ...over,
  });

describe('staleDigestText', () => {
  it('names the campaign, the repository, the days and the campaign page', () => {
    const text = digest();
    expect(text).toContain('*Bump lodash*');
    expect(text).toContain('1 draft pull request is stale');
    expect(text).toContain('acme/api');
    expect(text).toContain('past the 14-day limit');
    expect(text).toContain('stale for 3 days');
    expect(text).toContain(`https://dash.example.com/campaigns/${CAMPAIGN}`);
  });

  it('escapes a campaign name that tries to markup or broadcast', () => {
    const text = digest({ campaignName: '<!channel> <https://evil|click>', staleAfterDays: null });
    expect(text).not.toContain('<!channel>');
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).not.toContain('<https://evil');
  });

  it('escapes a repository label that tries to markup, broadcast or entity-inject', () => {
    const text = digest({
      named: [{ repoLabel: 'a&b/<!channel> <https://evil|click>', staleSince: NOW }],
    });
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<https://evil');
    expect(text).toContain('a&amp;b/&lt;!channel&gt;');
  });

  it('lists at most ten labels and counts the rest, and counts other teams without naming them', () => {
    const named = Array.from({ length: 13 }, (_, i) => ({
      repoLabel: `acme/repo-${i}`,
      staleSince: NOW,
    }));
    const text = digest({ named, otherTeamCount: 2 });
    expect(text).toContain('15 draft pull requests are stale');
    expect(text).toContain('acme/repo-9');
    expect(text).not.toContain('acme/repo-10');
    expect(text).toContain('and 3 more');
    expect(text).toContain('2 repositories of other teams');
  });
});

describe('notifyCampaignStale', () => {
  it('posts to the owning team’s notification channel', async () => {
    await notifyCampaignStale(input);
    expect(db.team.findUnique).toHaveBeenCalledWith({
      select: { slackNotifyChannel: true },
      where: { id: OWN },
    });
    expect(slack.post).toHaveBeenCalledTimes(1);
    expect(slack.post.mock.calls[0]?.[0]).toBe('C123');
    expect(slack.post.mock.calls[0]?.[1]).toContain('acme/api');
  });

  it('names a repository of the owning team and withholds, but counts, another team’s', async () => {
    await notifyCampaignStale({
      ...input,
      targets: [
        target('acme/api'),
        target('other/secret-repo', { teamId: 'team-2' }),
        target('other/second-secret', { teamId: 'team-3' }),
      ],
    });
    expect(slack.post).toHaveBeenCalledTimes(1);
    const text = slack.post.mock.calls[0]?.[1] as string;
    expect(text).toContain('acme/api');
    expect(text).not.toContain('secret');
    expect(text).toContain('3 draft pull requests are stale');
    expect(text).toContain('2 repositories of other teams');
  });

  it('names another team’s repository when it is shared with the owning team', async () => {
    db.connectionTeamShare.findMany.mockResolvedValue([{ connectionId: 'conn-other/shared' }]);
    await notifyCampaignStale({
      ...input,
      targets: [
        target('other/shared', { teamId: 'team-2' }),
        target('other/private', { teamId: 'team-2' }),
      ],
    });
    expect(db.connectionTeamShare.findMany.mock.calls[0]?.[0].where).toEqual({
      connectionId: { in: ['conn-other/shared', 'conn-other/private'] },
      teamId: OWN,
    });
    const text = slack.post.mock.calls[0]?.[1] as string;
    expect(text).toContain('other/shared');
    expect(text).not.toContain('other/private');
    expect(text).toContain('1 repository of other teams');
  });

  it('withholds every foreign name when the share lookup fails, and still posts', async () => {
    db.connectionTeamShare.findMany.mockRejectedValue(new Error('db down'));
    await notifyCampaignStale({
      ...input,
      targets: [target('acme/api'), target('other/shared', { teamId: 'team-2' })],
    });
    const text = slack.post.mock.calls[0]?.[1] as string;
    expect(text).toContain('acme/api');
    expect(text).not.toContain('other/shared');
  });

  it('sends one message for several targets', async () => {
    await notifyCampaignStale({
      ...input,
      targets: Array.from({ length: 30 }, (_, i) => target(`acme/repo-${i}`)),
    });
    expect(slack.post).toHaveBeenCalledTimes(1);
    expect(slack.post.mock.calls[0]?.[1]).toContain('and 20 more');
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

  it('never throws, and logs a failed post without the repository or the campaign name', async () => {
    slack.post.mockRejectedValue(new Error('chat.postMessage failed: channel_not_found'));
    await expect(
      notifyCampaignStale({
        ...input,
        targets: [target('acme/secret-repo'), target('acme/other')],
      })
    ).resolves.toBeUndefined();
    expect(slack.post).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('acme/');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Bump lodash');
    db.campaign.findUnique.mockRejectedValue(new Error('db down'));
    await expect(notifyCampaignStale(input)).resolves.toBeUndefined();
  });
});
