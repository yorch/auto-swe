/**
 * The join-request notification outbox, write side (`docs/specs/2026-11-24-team-join-requests-hardening.md` §5).
 *
 * The join-request service calls `enqueueJoinRequestEvent` INSIDE the transaction that creates or
 * decides a request, so the rows commit with the change they announce and a rolled-back
 * transaction leaves none. Nothing is sent here: the poller (`joinRequestNotificationPoller.ts`)
 * claims due rows and `deliverJoinRequestNotification` sends them. A close by the platform
 * (deactivation) never enqueues.
 */
import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { resolveSlackBotTokenForSlackChannel } from '@auto-swe/shared/lib/systemConfig';
import {
  AUDIENCE_CHANNEL,
  type JoinRequestNotificationEventValue,
  routeAudiences,
} from '@auto-swe/shared/lib/teamJoinRequests';

export interface EnqueueInput {
  requestId: string;
  event: JoinRequestNotificationEventValue;
  /** Whether the team has a Slack channel AND a bot token resolves for it. */
  team: { hasSlackChannel: boolean };
  /** `teams.joinRequestReviewerEmail`. */
  reviewerEmailEnabled: boolean;
}

/**
 * Inserts the outbox rows an event routes to. Idempotent: the unique `(requestId, event, audience)`
 * index plus `skipDuplicates` make a second enqueue of the same event a no-op. Returns how many
 * rows were created.
 */
export async function enqueueJoinRequestNotifications(
  tx: Prisma.TransactionClient,
  input: EnqueueInput
): Promise<number> {
  const routes = routeAudiences({
    event: input.event,
    reviewerEmailEnabled: input.reviewerEmailEnabled,
    teamHasSlackChannel: input.team.hasSlackChannel,
  });
  if (routes.length === 0) {
    return 0;
  }
  const { count } = await tx.joinRequestNotification.createMany({
    data: routes.map((route) => ({
      audience: route.audience,
      channel: AUDIENCE_CHANNEL[route.audience],
      event: input.event,
      requestId: input.requestId,
    })),
    skipDuplicates: true,
  });
  return count;
}

/** What routing a new request needs, read before the transaction that creates it. */
export interface CreatedRouting {
  hasSlackChannel: boolean;
  reviewerEmailEnabled: boolean;
}

/**
 * Looks up what the routing of a `CREATED` event needs: whether the team has a Slack channel with a
 * usable bot token, and the reviewer-email setting. It runs BEFORE the request's transaction opens,
 * on the pool, so a burst of creations never holds a pooled connection while it waits for a second
 * one. Only the Slack token lookup is forgiven: a Slack configuration that cannot be read or
 * decrypted is "no usable channel" and the reviewers are emailed instead. A database error or a bug
 * anywhere else here propagates and fails the request, which is the honest outcome.
 */
export async function resolveCreatedRouting(
  prisma: PrismaClient,
  input: { teamId: string; orgId: string }
): Promise<CreatedRouting> {
  const team = await prisma.team.findUnique({
    select: { slackNotifyChannel: true },
    where: { id: input.teamId },
  });
  const channel = team?.slackNotifyChannel ?? null;
  let hasSlackChannel = false;
  if (channel) {
    try {
      hasSlackChannel = Boolean(await resolveSlackBotTokenForSlackChannel(channel));
    } catch (err) {
      noteSlackLookupFailure(err);
    }
  }
  const reviewerEmailEnabled = await resolveSetting('teams.joinRequestReviewerEmail', {
    orgId: input.orgId,
    teamId: input.teamId,
  });
  return { hasSlackChannel, reviewerEmailEnabled };
}

/** The least time between two log lines about an unreadable Slack configuration. */
export const SLACK_LOOKUP_LOG_INTERVAL_MS = 60_000;

let lastSlackLookupLogAt = Number.NEGATIVE_INFINITY;
let slackLogClock: () => number = Date.now;

/** Logs at most once per `SLACK_LOOKUP_LOG_INTERVAL_MS`, by error type only: the text can name a secret. */
function noteSlackLookupFailure(err: unknown): void {
  const now = slackLogClock();
  if (now - lastSlackLookupLogAt < SLACK_LOOKUP_LOG_INTERVAL_MS) {
    return;
  }
  lastSlackLookupLogAt = now;
  console.warn(
    `[join-request-notify] the Slack configuration could not be read (${(err as Error)?.name ?? 'Error'}); reviewers are emailed instead of the team channel`
  );
}

/** Test hook: forget the last Slack lookup log line, and optionally replace the clock it reads. */
export function resetOutboxWarningsForTests(clock: () => number = Date.now): void {
  lastSlackLookupLogAt = Number.NEGATIVE_INFINITY;
  slackLogClock = clock;
}

/**
 * The service's entry point, called inside the request's transaction. It reads nothing that could
 * wait for a second connection: a `CREATED` event carries the routing `resolveCreatedRouting`
 * returned before the transaction opened; every other event routes on its own and needs none.
 */
export async function enqueueJoinRequestEvent(
  tx: Prisma.TransactionClient,
  input: { requestId: string } & (
    | { event: 'CREATED'; routing: CreatedRouting }
    | { event: Exclude<JoinRequestNotificationEventValue, 'CREATED'> }
  )
): Promise<number> {
  const routing: CreatedRouting =
    input.event === 'CREATED'
      ? input.routing
      : { hasSlackChannel: false, reviewerEmailEnabled: false };
  return enqueueJoinRequestNotifications(tx, {
    event: input.event,
    requestId: input.requestId,
    reviewerEmailEnabled: routing.reviewerEmailEnabled,
    team: { hasSlackChannel: routing.hasSlackChannel },
  });
}
