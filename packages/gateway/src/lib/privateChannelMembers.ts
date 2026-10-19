import type { Prisma } from '@auto-swe/shared';
import { resolveScheduledSweeps } from '@auto-swe/shared/lib/systemConfig';

/**
 * Who, besides a platform ADMIN, may read a private Slack channel's conversations — its memory,
 * open items, audit feed and turn runs: a member of the channel's owning team (checked by the
 * caller) whose linked Slack account is in the channel's member list, as the Slack channel sync
 * last recorded it, and only while that list is fresh.
 *
 * Fail-closed in every direction: no linked Slack account, a channel the sync never read, or a
 * list older than `SLACK_CHANNEL_SYNC_STALE_HOURS` grants nothing, so turning the sync off
 * returns every private channel to admin-only within that window. The caller's `slackId` is the
 * one the auth layer re-reads from the user row on every request, never a token claim.
 */

/** The oldest `membersSyncedAt` that still counts. */
export function membersFreshSince(now = new Date()): Date {
  const hours = resolveScheduledSweeps().slackChannelSync.staleAfterHours;
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

/**
 * The private-channel half of a `SlackChannel` where-clause: channels the given Slack user is a
 * current member of. Null when the caller has no linked Slack account, which matches nothing.
 */
export function privateChannelMemberWhere(
  slackId: string | undefined,
  now = new Date()
): Prisma.SlackChannelWhereInput | null {
  if (!slackId) {
    return null;
  }
  return {
    isPrivate: true,
    members: { some: { slackUserId: slackId } },
    membersSyncedAt: { gte: membersFreshSince(now) },
  };
}
