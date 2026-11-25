/**
 * Delivery for notification emails: messages that carry no credential (a decision on a join
 * request, a request awaiting an organization admin, a new request for a team's reviewers). They
 * share the sign-in transport resolution in `authEmail.ts` but use its BOUNDED profile (finite
 * connection timeouts and an abort signal) so that one slow relay cannot hold an outbox row past
 * its lease. This module only reports, per message, whether a transport accepted it, refused it or
 * left the outcome unknown; what a failure means (retry with backoff, skip, warn once) is decided
 * by the outbox poller. It never throws.
 */
import {
  emailTransportConfigured,
  sendViaConfiguredTransport,
  type TransportMessage,
} from './authEmail.js';

export interface NotificationEmail extends TransportMessage {}

/**
 * The longest one message may take, whatever the transport does. The SMTP timeouts bound each step
 * (connect, greeting, one command's silence) but not their sum, so a relay that answers slowly
 * enough at every step could hold a send for minutes. A message past this is abandoned. It is far
 * below the outbox lease (`CLAIM_LEASE_MS`), which the poller also refreshes before each recipient,
 * so a recipient's send never outlives the lease it started under.
 */
export const NOTIFICATION_SEND_DEADLINE_MS = 90_000;

/**
 * How one message ended. `unknown` is the deadline's verdict and the only place that makes it: the
 * send was abandoned (its socket destroyed, its fallback never started) without a transport having
 * said yes or no. An unknown message MAY ALREADY HAVE BEEN DELIVERED, because a relay that has read
 * the whole message can accept it whatever the client does next. The caller counts it as a failed
 * attempt and sends it again, which makes delivery at-least-once for exactly this case.
 */
type SendVerdict = 'accepted' | 'refused' | 'unknown';

async function sendWithDeadline(
  message: NotificationEmail,
  deadlineMs: number
): Promise<SendVerdict> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'unknown'>((resolve) => {
    timer = setTimeout(() => {
      // Abort first: it destroys the SMTP socket and forbids the Resend fallback, so the send that
      // loses the race below cannot go on in the background.
      controller.abort();
      resolve('unknown');
    }, deadlineMs);
  });
  try {
    const verdict = await Promise.race([
      sendViaConfiguredTransport(message, {
        bounded: true,
        continueOnError: true,
        signal: controller.signal,
        // A send that loses the race settles on its own (its socket was destroyed); its late error
        // must not surface as an unhandled rejection.
      }).then(
        (result): SendVerdict => (result.sent ? 'accepted' : 'refused'),
        (): SendVerdict => 'refused'
      ),
      expired,
    ]);
    // A send that failed BECAUSE the deadline destroyed it is unknown too, not refused.
    return controller.signal.aborted && verdict !== 'accepted' ? 'unknown' : verdict;
  } finally {
    clearTimeout(timer);
  }
}

export interface EachEmailResult {
  /** False when no transport is configured; nothing was attempted. */
  configured: boolean;
  /** The `to` of every message a transport accepted, in order. */
  delivered: string[];
  /** How many messages no transport accepted, `unknown` ones included. */
  failed: number;
  /**
   * How many of `failed` were abandoned at the deadline with no answer. They may have been
   * delivered anyway.
   */
  unknown: number;
}

/**
 * Sends `messages` one by one and reports which were accepted, for a caller that keeps its own
 * record (the join-request outbox). It says whether a transport exists and which messages got
 * through, so a retry can skip the ones that did. Never throws. The log line carries a count only:
 * a transport's error text can name an address.
 */
export async function sendNotificationEmailsEach(
  kind: string,
  messages: readonly NotificationEmail[],
  deadlineMs: number = NOTIFICATION_SEND_DEADLINE_MS
): Promise<EachEmailResult> {
  if (!emailTransportConfigured()) {
    return { configured: false, delivered: [], failed: 0, unknown: 0 };
  }
  const delivered: string[] = [];
  let failed = 0;
  let unknown = 0;
  for (const message of messages) {
    try {
      const verdict = await sendWithDeadline(message, deadlineMs);
      if (verdict === 'accepted') {
        delivered.push(message.to);
      } else {
        failed += 1;
        if (verdict === 'unknown') {
          unknown += 1;
        }
      }
    } catch {
      failed += 1;
    }
  }
  if (failed > 0) {
    console.warn(
      `[${kind}] ${failed} of ${messages.length} email(s) were not accepted${unknown > 0 ? ` (${unknown} gave no answer in time and may still arrive)` : ''}`
    );
  }
  return { configured: true, delivered, failed, unknown };
}

/** Escapes text for an HTML body. Every person-written string goes through this. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
