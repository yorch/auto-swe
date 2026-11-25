import { prisma } from '@auto-swe/shared/db';
import {
  resolveSlackBotTokenForSlackChannel,
  resolveWebUrl,
} from '@auto-swe/shared/lib/systemConfig';
import { logWarn } from './activityLog.js';
import { escapeSlackText } from './slackEscape.js';
import { postSlackChannelMessage } from './slackNotify.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Repository labels one digest names; the rest are counted. */
export const STALE_DIGEST_MAX_LABELS = 10;

/**
 * The one message a pass's newly stale targets earn together. Fixed wording; the only variable parts
 * are the campaign's name and the repository labels, both escaped (the name is typed by a person),
 * the numbers, and the campaign page's link. The post path defuses broadcast mentions as well.
 *
 * `named` holds only repositories the channel's team may see; targets of other teams arrive as
 * `otherTeamCount` and are never named. At most {@link STALE_DIGEST_MAX_LABELS} labels are listed,
 * the remainder counted ("and N more").
 */
export function staleDigestText(input: {
  campaignId: string;
  campaignName: string;
  named: ReadonlyArray<{ repoLabel: string; staleSince: number }>;
  otherTeamCount: number;
  staleAfterDays: number | null;
  now: number;
}): string {
  const total = input.named.length + input.otherTeamCount;
  const threshold =
    input.staleAfterDays === null ? '' : ` past the ${input.staleAfterDays}-day limit`;
  const url = `${resolveWebUrl().replace(/\/+$/, '')}/campaigns/${encodeURIComponent(input.campaignId)}`;
  const lines = [
    `:hourglass_flowing_sand: Campaign *${escapeSlackText(input.campaignName)}*: ${total} draft pull request${total === 1 ? ' is' : 's are'} stale (open${threshold}). ${url}`,
  ];
  for (const t of input.named.slice(0, STALE_DIGEST_MAX_LABELS)) {
    const daysStale = Math.max(0, Math.floor((input.now - t.staleSince) / DAY_MS));
    const duration =
      daysStale > 0 ? ` (stale for ${daysStale} day${daysStale === 1 ? '' : 's'})` : '';
    lines.push(`• ${escapeSlackText(t.repoLabel)}${duration}`);
  }
  const more = input.named.length - STALE_DIGEST_MAX_LABELS;
  if (more > 0) {
    lines.push(`• and ${more} more`);
  }
  if (input.otherTeamCount > 0) {
    lines.push(
      `• ${input.otherTeamCount} ${input.otherTeamCount === 1 ? 'repository' : 'repositories'} of other teams`
    );
  }
  return lines.join('\n');
}

/**
 * Tell the campaign's owning team's Slack notification channel (`Team.slackNotifyChannel`) that
 * targets went stale, in ONE message. The caller sends it only for targets whose `staleSince` write
 * landed (a conditional update that matched), so a retried activity does not repeat it.
 *
 * A repository is named only when the channel's team may see it: its target belongs to the
 * campaign's owning team, or its connection is shared with that team. Every other target is only
 * counted, so a campaign that spans teams does not leak repository names into a channel whose
 * members cannot see them (the dashboard hides such targets the same way). A share lookup that
 * fails withholds the names rather than guessing.
 *
 * Does nothing when the team has no channel or no bot token resolves for it. Best effort: never
 * throws, and a failure is logged without the repository label or the campaign name. One post, so
 * the post's own 2 s timeout bounds the whole notice.
 */
export async function notifyCampaignStale(input: {
  campaignId: string;
  targets: Array<{
    repoLabel: string;
    staleSince: number;
    teamId: string;
    connectionId: string | null;
  }>;
  now: number;
}): Promise<void> {
  try {
    if (input.targets.length === 0) {
      return;
    }
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
    const foreign = input.targets.flatMap((t) =>
      t.teamId !== campaign.ownerTeamId && t.connectionId ? [t.connectionId] : []
    );
    let sharedWithOwner = new Set<string>();
    if (foreign.length > 0) {
      try {
        const shares = await prisma.connectionTeamShare.findMany({
          select: { connectionId: true },
          where: { connectionId: { in: foreign }, teamId: campaign.ownerTeamId },
        });
        sharedWithOwner = new Set(shares.map((s) => s.connectionId));
      } catch {
        // Unreadable: no foreign repository is named.
      }
    }
    const named = input.targets.filter(
      (t) =>
        t.teamId === campaign.ownerTeamId ||
        (t.connectionId !== null && sharedWithOwner.has(t.connectionId))
    );
    await postSlackChannelMessage(
      channel,
      staleDigestText({
        campaignId: input.campaignId,
        campaignName: campaign.name,
        named,
        now: input.now,
        otherTeamCount: input.targets.length - named.length,
        staleAfterDays: campaign.staleAfterDays,
      })
    );
  } catch (err) {
    logWarn('Campaign stale notice not sent', {
      campaignId: input.campaignId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
