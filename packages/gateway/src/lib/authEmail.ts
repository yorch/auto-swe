/**
 * Delivery for better-auth's emailed links — magic sign-in links and password
 * resets. Both carry a live bearer credential in `url`, so both go through the
 * one transport resolution here:
 *
 *   1. SMTP_HOST + SMTP_PORT + AUTH_FROM_EMAIL → nodemailer (Mailgun, Postmark,
 *      SES via SMTP credentials, self-hosted Postfix, …)
 *   2. RESEND_API_KEY + AUTH_FROM_EMAIL → Resend's HTTP API
 *   3. Development / test only → the URL is printed to stdout for copy-paste
 *
 * Outside development and test there is no third step. Printing the URL there
 * would write a working sign-in or reset link into production logs, where
 * anyone who can read them can take over the account; so an unconfigured or
 * failing transport throws, and the error that is logged never contains the
 * URL. An unset NODE_ENV counts as production, the same rule every other
 * dev-only fallback in the gateway follows.
 */
import net from 'node:net';
import { resolveAuthEmailConfig } from '@auto-swe/shared/lib/systemConfig';
import nodemailer, { type Transporter } from 'nodemailer';

export interface AuthEmail {
  /** Log tag, e.g. `magic-link`. Never the URL. */
  kind: 'magic-link' | 'password-reset';
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The credential-bearing link. Only ever printed in development/test. */
  url: string;
  /** Human-readable lifetime for the dev log line. */
  expiresIn: string;
}

function devLogAllowed(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}

/**
 * Finite SMTP timeouts for the notification path. nodemailer's defaults are minutes long (2 min to
 * connect, 30 s for the greeting, 10 min of socket silence), so a stalled relay would hold a
 * delivery far past the outbox lease. The sign-in and password-reset path keeps the defaults.
 */
export const NOTIFICATION_SMTP_TIMEOUTS = {
  /** Opening the connection. */
  connectionTimeout: 15_000,
  /** The server's greeting after the connection opens. */
  greetingTimeout: 15_000,
  /** Silence on an open socket, per command. */
  socketTimeout: 30_000,
} as const;

/** The sign-in and password-reset transporter: lazy, rebuilt when the SMTP settings change. */
let defaultTransporter: { key: string; transporter: Transporter } | undefined;

function smtpOptions(socket?: net.Socket) {
  const { authFromEmail, smtpHost, smtpPass, smtpPort, smtpUser } = resolveAuthEmailConfig();
  if (!(smtpHost && smtpPort && authFromEmail)) {
    return null;
  }
  return {
    key: JSON.stringify([smtpHost, smtpPort, smtpUser, smtpPass]),
    options: {
      auth: smtpUser && smtpPass ? { pass: smtpPass, user: smtpUser } : undefined,
      host: smtpHost,
      port: smtpPort,
      // STARTTLS on 587, implicit TLS on 465. Match real-world provider defaults.
      secure: smtpPort === 465,
      ...(socket ? { socket, ...NOTIFICATION_SMTP_TIMEOUTS } : {}),
    },
  };
}

/**
 * The transporter for one send. The default profile is shared and cached. The bounded profile is
 * built per send around a socket this module owns (`options.socket`: nodemailer connects that very
 * object, upgrades it for TLS when needed, and never hides it), because a send that outlives its
 * deadline can only be stopped by destroying its socket: `transporter.close()` ends pooled
 * connections and does nothing to a plain one that is mid-send.
 */
function getSmtpTransporter(
  bounded: boolean
): { transporter: Transporter; socket?: net.Socket } | null {
  if (bounded) {
    const socket = new net.Socket();
    const config = smtpOptions(socket);
    return config ? { socket, transporter: nodemailer.createTransport(config.options) } : null;
  }
  const config = smtpOptions();
  if (!config) {
    return null;
  }
  if (defaultTransporter?.key !== config.key) {
    defaultTransporter = {
      key: config.key,
      transporter: nodemailer.createTransport(config.options),
    };
  }
  return { transporter: defaultTransporter.transporter };
}

export class AuthEmailTransportError extends Error {
  constructor(kind: AuthEmail['kind'], reason: string) {
    super(`Cannot deliver ${kind} email: ${reason}`);
    this.name = 'AuthEmailTransportError';
  }
}

/**
 * Whether an emailed link can reach anyone: a transport is configured, or this
 * is development/test, where the link is printed instead. The login page hides
 * magic-link sign-in when this is false rather than offering a button that
 * can only fail.
 */
export function authEmailAvailable(): boolean {
  const { authFromEmail, resendApiKey, smtpHost, smtpPort } = resolveAuthEmailConfig();
  const smtp = Boolean(smtpHost && smtpPort && authFromEmail);
  const resend = Boolean(resendApiKey && authFromEmail);
  return smtp || resend || devLogAllowed();
}

export interface TransportMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Whether an SMTP or Resend transport is configured (not whether it works). */
export function emailTransportConfigured(): boolean {
  const { authFromEmail, resendApiKey, smtpHost, smtpPort } = resolveAuthEmailConfig();
  return Boolean(authFromEmail && ((smtpHost && smtpPort) || resendApiKey));
}

/**
 * The one transport resolution: SMTP first, then Resend. Resolves `{ sent: true }` once a transport
 * accepted the message and `{ sent: false, failures }` when none is configured or, with
 * `continueOnError`, when every configured one failed. Without `continueOnError` a failing
 * transport throws at once, which is what the sign-in path needs outside development/test.
 * Error text never includes the message body.
 */
export async function sendViaConfiguredTransport(
  message: TransportMessage,
  options: {
    continueOnError: boolean;
    /**
     * Finite SMTP timeouts and a bounded Resend request, for a caller that holds a lease while it
     * sends (the join-request outbox). Sign-in and reset links leave it off and keep the defaults.
     */
    bounded?: boolean;
    /**
     * Only with `bounded`: the caller's deadline. Once it fires the send is abandoned, and for good:
     * the SMTP socket is destroyed so a relay cannot go on accepting it in the background, and the
     * Resend fallback is never started. A send abandoned this way has an UNKNOWN outcome (the relay
     * may already have accepted the message), which is the caller's to treat as at-least-once.
     */
    signal?: AbortSignal;
  }
): Promise<{ sent: true } | { sent: false; failures: string[] }> {
  const { authFromEmail, resendApiKey } = resolveAuthEmailConfig();
  const { to, subject, text, html } = message;
  const failures: string[] = [];
  const bounded = options.bounded === true;
  const signal = bounded ? options.signal : undefined;
  if (signal?.aborted) {
    return { failures: ['the deadline passed before the send started'], sent: false };
  }

  const smtp = getSmtpTransporter(bounded);
  if (smtp) {
    const abandon = () => {
      smtp.socket?.destroy();
      try {
        smtp.transporter.close();
      } catch {
        // Releasing a transporter is best effort; the socket is already gone.
      }
    };
    signal?.addEventListener('abort', abandon, { once: true });
    try {
      const info = await smtp.transporter.sendMail({
        from: authFromEmail ?? undefined,
        html,
        subject,
        text,
        to,
      });
      // SMTP `sendMail` resolves on submission acceptance, not on delivery.
      // A non-empty rejected list with nothing accepted means the relay refused
      // the address even though the call "succeeded".
      if ((info.rejected ?? []).length > 0 && (info.accepted ?? []).length === 0) {
        throw new Error(`SMTP relay rejected the recipient: ${info.response}`);
      }
      return { sent: true };
    } catch (err) {
      if (!options.continueOnError) {
        throw err;
      }
      failures.push(`SMTP: ${(err as Error).message}`);
    } finally {
      signal?.removeEventListener('abort', abandon);
      if (bounded) {
        // Nothing reuses a bounded transporter; make sure its socket does not outlive the send.
        smtp.socket?.destroy();
      }
    }
  }

  // A deadline that fired during the SMTP attempt abandoned the whole send: a second transport
  // started now would run outside the caller's lease and could deliver the message again.
  if (signal?.aborted) {
    return { failures, sent: false };
  }

  if (resendApiKey && authFromEmail) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        body: JSON.stringify({ from: authFromEmail, html, subject, text, to }),
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        redirect: 'error',
        ...(bounded
          ? {
              signal: signal
                ? AbortSignal.any([
                    signal,
                    AbortSignal.timeout(NOTIFICATION_SMTP_TIMEOUTS.socketTimeout),
                  ])
                : AbortSignal.timeout(NOTIFICATION_SMTP_TIMEOUTS.socketTimeout),
            }
          : {}),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Resend returned ${res.status}: ${body.slice(0, 200)}`);
      }
      return { sent: true };
    } catch (err) {
      if (!options.continueOnError) {
        throw err;
      }
      failures.push(`Resend: ${(err as Error).message}`);
    }
  }
  return { failures, sent: false };
}

export async function deliverAuthEmail(message: AuthEmail): Promise<void> {
  const { kind } = message;
  const result = await sendViaConfiguredTransport(message, { continueOnError: devLogAllowed() });
  if (result.sent) {
    return;
  }
  const failures = result.failures;

  if (!devLogAllowed()) {
    // No URL in this message: it reaches the logs, and the URL is a credential.
    const error = new AuthEmailTransportError(
      kind,
      'no email transport is configured (set SMTP_* or RESEND_API_KEY, plus AUTH_FROM_EMAIL)'
    );
    console.error(`[${kind}] ${error.message}`);
    throw error;
  }

  for (const failure of failures) {
    console.warn(`[${kind}] ${failure}; falling back to the dev log`);
  }
  console.log(
    `\n[${kind}] → ${message.to}\n[${kind}]   ${message.url}\n[${kind}]   (link expires in ${message.expiresIn})\n`
  );
}
