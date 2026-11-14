import type { PrismaClient } from '@auto-swe/shared';
import { decryptSecret } from '@auto-swe/shared/lib/crypto';
import { createGuardedFetch } from '@auto-swe/shared/lib/guardedDispatcher';

/** PagerDuty's Events API v2 change-event intake; a routing key is accepted nowhere else. */
export const PAGERDUTY_CHANGE_EVENTS_URL = 'https://events.pagerduty.com/v2/change/enqueue';

const TIMEOUT_MS = 5_000;
/** PagerDuty's limit on a change event's summary. */
const SUMMARY_MAX_CHARS = 1024;

export interface MergedPullRequest {
  org: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  title: string | null;
  mergedAt: Date;
  ticketId: string | null;
}

/** An Events API v2 change event, routing key aside. */
export interface ChangeEvent {
  links: { href: string; text: string }[];
  payload: {
    custom_details: Record<string, unknown>;
    source: string;
    summary: string;
    timestamp: string;
  };
}

/** The change event for a merged pull request. */
export function mergeChangeEvent(pr: MergedPullRequest): ChangeEvent {
  const repo = `${pr.org}/${pr.repoName}`;
  const summary = `Merged ${repo}#${pr.prNumber}${pr.title ? `: ${pr.title}` : ''}`;
  return {
    links: [{ href: pr.prUrl, text: `Pull request #${pr.prNumber}` }],
    payload: {
      custom_details: {
        pull_request: pr.prNumber,
        repository: repo,
        ...(pr.ticketId ? { ticket: pr.ticketId } : {}),
      },
      source: 'auto-swe',
      summary: summary.slice(0, SUMMARY_MAX_CHARS),
      timestamp: pr.mergedAt.toISOString(),
    },
  };
}

/** The HTTP status PagerDuty answered, or 0 when it could not be reached. */
export async function postChangeEvent(
  routingKey: string,
  event: ChangeEvent,
  doFetch: typeof fetch = createGuardedFetch({ allowPrivate: false })
): Promise<number> {
  try {
    const res = await doFetch(PAGERDUTY_CHANGE_EVENTS_URL, {
      body: JSON.stringify({ ...event, routing_key: routingKey }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.status;
  } catch {
    return 0;
  }
}

interface Log {
  warn: (obj: object, msg: string) => void;
}

/**
 * Send a change event for a merged pull request to the repository's `pagerduty_events`
 * connection, when it names an active one with a routing key. Best-effort: it never throws, and a
 * failure is only logged, so PagerDuty can never hold up recording the merge.
 */
export async function sendMergeChangeEvent(
  prisma: Pick<PrismaClient, 'connection'>,
  pagerdutyEventsConnectionId: string | null | undefined,
  pr: MergedPullRequest,
  log: Log,
  doFetch?: typeof fetch
): Promise<boolean> {
  if (!pagerdutyEventsConnectionId) {
    return false;
  }
  try {
    const conn = await prisma.connection.findUnique({
      select: {
        apiKeyAuthTag: true,
        apiKeyCiphertext: true,
        apiKeyNonce: true,
        apiKeyVersion: true,
        isActive: true,
        type: true,
      },
      where: { id: pagerdutyEventsConnectionId },
    });
    if (
      conn?.type !== 'pagerduty_events' ||
      !conn.isActive ||
      !(conn.apiKeyCiphertext && conn.apiKeyNonce && conn.apiKeyAuthTag)
    ) {
      log.warn(
        { connectionId: pagerdutyEventsConnectionId },
        'PagerDuty change event skipped: the connection is inactive or has no routing key'
      );
      return false;
    }
    const routingKey = decryptSecret({
      authTag: conn.apiKeyAuthTag,
      ciphertext: conn.apiKeyCiphertext,
      keyVersion: conn.apiKeyVersion,
      nonce: conn.apiKeyNonce,
    });
    const status = await postChangeEvent(routingKey, mergeChangeEvent(pr), doFetch);
    if (status < 200 || status >= 300) {
      log.warn(
        { connectionId: pagerdutyEventsConnectionId, prNumber: pr.prNumber, status },
        'PagerDuty change event was not accepted (non-fatal)'
      );
      return false;
    }
    return true;
  } catch (err) {
    log.warn(
      { connectionId: pagerdutyEventsConnectionId, err },
      'PagerDuty change event failed (non-fatal)'
    );
    return false;
  }
}
