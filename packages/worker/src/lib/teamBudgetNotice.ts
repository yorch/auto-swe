import { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { usdToCents } from '@auto-swe/shared/lib/billing';
import {
  resolveSlackBotTokenForSlackChannel,
  resolveWebUrl,
} from '@auto-swe/shared/lib/systemConfig';
import { logWarn } from './activityLog.js';
import { escapeSlackText } from './slackEscape.js';
import { postSlackChannelMessage } from './slackNotify.js';

export type TeamBudgetNoticeLevel = 'CAP_REACHED' | 'WARNING';

/**
 * The notice a team's month-to-date spend has earned, if any: `CAP_REACHED` at or past the cap
 * (a cap of 0 is reached with nothing spent, as the guard reads it), else `WARNING` at or past the
 * alert threshold. A team with no cap, and a team with no threshold below the cap, earns none.
 * Pure. Integer arithmetic in cents so a threshold is not decided by float rounding.
 */
export function dueTeamBudgetLevel(input: {
  capCents: number | null;
  spentCents: number;
  thresholdPercent: number | null;
}): TeamBudgetNoticeLevel | null {
  const { capCents, spentCents, thresholdPercent } = input;
  if (capCents == null) {
    return null;
  }
  if (spentCents >= capCents) {
    return 'CAP_REACHED';
  }
  if (thresholdPercent != null && spentCents * 100 >= capCents * thresholdPercent) {
    return 'WARNING';
  }
  return null;
}

/** The UTC calendar month `YYYY-MM`, the month `teamMonthSpend` counts. */
export function budgetPeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

function noticeText(input: {
  capCents: number;
  level: TeamBudgetNoticeLevel;
  period: string;
  slug: string;
  spentCents: number;
  teamName: string;
}): string {
  const percent =
    input.capCents <= 0 ? 100 : Math.round((input.spentCents / input.capCents) * 1000) / 10;
  const link = `${resolveWebUrl().replace(/\/+$/, '')}/teams/${encodeURIComponent(input.slug)}/settings`;
  const headline =
    input.level === 'CAP_REACHED'
      ? 'has reached its monthly budget; new runs are blocked until next month or a higher cap'
      : 'has crossed its budget alert threshold';
  return (
    `*Team ${escapeSlackText(input.teamName)}* ${headline} (${input.period}): ` +
    `${percent}% used, ${usd(input.spentCents)} of ${usd(input.capCents)}. ` +
    `Team budget: ${link}`
  );
}

/**
 * Slack `chat.postMessage` errors that retrying cannot clear within the month: the channel is
 * gone, archived or not joined, or the token is invalid, revoked or lacks the scope. Anything
 * else (rate limit, 5xx, network, timeout) is treated as transient.
 */
const PERMANENT_SLACK_ERRORS = new Set([
  'account_inactive',
  'channel_not_found',
  'invalid_auth',
  'is_archived',
  'missing_scope',
  'not_authed',
  'not_in_channel',
  'token_revoked',
]);

/** True when `err` carries one of {@link PERMANENT_SLACK_ERRORS} as its Slack error code. */
export function isPermanentSlackPostError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = /chat\.postMessage failed: ([a-z_]+)/.exec(message)?.[1];
  return code !== undefined && PERMANENT_SLACK_ERRORS.has(code);
}

/**
 * Tells the team's Slack notify channel (`Team.slackNotifyChannel`) once per UTC month when its
 * spend first crosses the alert threshold and once when it reaches the cap. The marker is a
 * `TeamBudgetNotice` row claimed by `create`, so a unique violation means another evaluation owns
 * the notice and this one sends nothing. The claim is taken only once a channel and a bot token
 * resolve, so a team that configures its channel later is still told this month. When the post
 * fails transiently the claim is released so the next evaluation retries; when it fails
 * permanently (see {@link isPermanentSlackPostError}) the claim is kept and the failure logged
 * once, so a bad channel is not retried every cache window by every process for the rest of the
 * month (fixing the channel then takes effect next month).
 *
 * Best effort: never throws.
 */
export async function evaluateTeamBudgetNotice(
  teamId: string,
  spentUsd: number,
  now: Date = new Date()
): Promise<void> {
  try {
    const team = await prisma.team.findUnique({
      select: {
        budgetAlertThresholdPercent: true,
        monthlyBudgetUsdCents: true,
        name: true,
        slackNotifyChannel: true,
        slug: true,
      },
      where: { id: teamId },
    });
    const capCents = team?.monthlyBudgetUsdCents ?? null;
    if (!team || capCents == null) {
      return;
    }
    const spentCents = usdToCents(spentUsd);
    const level = dueTeamBudgetLevel({
      capCents,
      spentCents,
      thresholdPercent: team.budgetAlertThresholdPercent ?? null,
    });
    if (!level || !team.slackNotifyChannel) {
      return;
    }
    if (!(await resolveSlackBotTokenForSlackChannel(team.slackNotifyChannel))) {
      return;
    }
    const period = budgetPeriod(now);
    try {
      await prisma.teamBudgetNotice.create({ data: { level, period, teamId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return;
      }
      throw err;
    }
    try {
      await postSlackChannelMessage(
        team.slackNotifyChannel,
        noticeText({ capCents, level, period, slug: team.slug, spentCents, teamName: team.name })
      );
    } catch (err) {
      if (isPermanentSlackPostError(err)) {
        // Claim kept: logged here, once, and not rethrown into the generic warning below.
        logWarn('Team budget notice cannot be delivered; not retrying this month', {
          error: err instanceof Error ? err.message : String(err),
          level,
          period,
          teamId,
        });
        return;
      }
      await prisma.teamBudgetNotice
        .delete({ where: { teamId_period_level: { level, period, teamId } } })
        .catch(() => undefined);
      throw err;
    }
  } catch (err) {
    logWarn('Team budget notice not sent', {
      error: err instanceof Error ? err.message : String(err),
      teamId,
    });
  }
}
