/**
 * Delivery for notification emails: messages that carry no credential (a decision on a join
 * request, a request awaiting an organization admin). They share the sign-in transport resolution
 * in `authEmail.ts` but differ in two ways that matter:
 *
 *   - nothing here is a bearer credential, so there is no dev-log fallback that prints a body; in
 *     development and test with no transport only the kind and the recipient count are logged;
 *   - delivery is best effort. Outside development and test with no transport configured the send
 *     is skipped with ONE warning per process, and a transport error is logged (never the body) and
 *     swallowed. This module never throws.
 */
import {
  emailTransportConfigured,
  sendViaConfiguredTransport,
  type TransportMessage,
} from './authEmail.js';

function devLogAllowed(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}

let warnedNoTransport = false;

/** Test hook: forget that the no-transport warning was already printed. */
export function resetNotificationEmailWarning(): void {
  warnedNoTransport = false;
}

export interface NotificationEmail extends TransportMessage {}

/**
 * Sends `messages` one by one. Returns how many a transport accepted. Never throws.
 * `kind` is a log tag such as `join-request-decided`.
 */
export async function sendNotificationEmails(
  kind: string,
  messages: readonly NotificationEmail[]
): Promise<number> {
  if (messages.length === 0) {
    return 0;
  }
  try {
    if (!emailTransportConfigured()) {
      if (devLogAllowed()) {
        console.log(`[${kind}] no email transport configured; ${messages.length} recipient(s)`);
      } else if (!warnedNoTransport) {
        warnedNoTransport = true;
        console.warn(
          `[${kind}] no email transport is configured (set SMTP_* or RESEND_API_KEY, plus AUTH_FROM_EMAIL); notification emails are skipped`
        );
      }
      return 0;
    }
    let sent = 0;
    for (const message of messages) {
      try {
        const result = await sendViaConfiguredTransport(message, { continueOnError: true });
        if (result.sent) {
          sent += 1;
        } else {
          console.warn(`[${kind}] email not delivered: ${result.failures.join('; ')}`);
        }
      } catch (err) {
        console.warn(`[${kind}] email not delivered: ${(err as Error).message}`);
      }
    }
    return sent;
  } catch (err) {
    console.warn(`[${kind}] email delivery failed: ${(err as Error).message}`);
    return 0;
  }
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
