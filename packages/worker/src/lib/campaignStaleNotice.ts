import { prisma } from '@auto-swe/shared/db';
import {
  resolveSlackBotTokenForSlackChannel,
  resolveWebUrl,
} from '@auto-swe/shared/lib/systemConfig';
import { logWarn } from './activityLog.js';
import { escapeSlackText } from './slackEscape.js';
import { postSlackChannelMessage } from './slackNotify.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The one message a target earns when it first goes stale. Fixed wording; the only variable parts
 * are the campaign's name and the repository label, both escaped (the name is typed by a person),
 * the numbers, and the campaign page's link. The post path defuses broadcast mentions as well.
 */
export function staleNoticeText(input: {
  campaignId: string;
  campaignName: string;
  repoLabel: string;
  staleAfterDays: number | null;
  staleSince: number;
  now: number;
}): string {
  const daysStale = Math.max(0, Math.floor((input.now - input.staleSince) / DAY_MS));
  const threshold =
    input.staleAfterDays === null ? '' : ` past the ${input.staleAfterDays}-day limit`;
  const duration = daysStale > 0 ? `, stale for ${daysStale} day${daysStale === 1 ? '' : 's'}` : '';
  const url = `${resolveWebUrl().replace(/\/+$/, '')}/campaigns/${encodeURIComponent(input.campaignId)}`;
  return `:hourglass_flowing_sand: Campaign *${escapeSlackText(input.campaignName)}*: the draft pull request for ${escapeSlackText(input.repoLabel)} is stale (open${threshold}${duration}). ${url}`;
}

/**
 * Tell the campaign's owning team's Slack notification channel (`Team.slackNotifyChannel`) that
 * targets went stale. The caller sends it only for a target whose `staleSince` write landed (a
 * conditional update that matched), so a retried activity does not repeat it.
 *
 * Does nothing when the team has no channel or no bot token resolves for it. Best effort: never
 * throws, and a failure is logged without the repository label or the campaign name.
 */
export async function notifyCampaignStale(input: {
  campaignId: string;
  targets: Array<{ repoLabel: string; staleSince: number }>;
  now: number;
}): Promise<void> {
  try {
    const campaign = await prisma.campaign.findUnique({
      select: { name: true, orgId: true, ownerTeamId: true, staleAfterDays: true },
      where: { id: input.campaignId },
    });
    if (!campaign) {
      return;
    }
    const team = await prisma.team.findUnique({
      select: { slackNotifyChannel: true },
      where: { id: campaign.ownerTeamId },
    });
    const channel = team?.slackNotifyChannel ?? null;
    if (!channel || !(await resolveSlackBotTokenForSlackChannel(channel))) {
      return;
    }
    for (const target of input.targets) {
      try {
        await postSlackChannelMessage(
          channel,
          staleNoticeText({
            campaignId: input.campaignId,
            campaignName: campaign.name,
            now: input.now,
            repoLabel: target.repoLabel,
            staleAfterDays: campaign.staleAfterDays,
            staleSince: target.staleSince,
          })
        );
      } catch (err) {
        logWarn('Campaign stale notice not sent', {
          campaignId: input.campaignId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logWarn('Campaign stale notice not sent', {
      campaignId: input.campaignId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
