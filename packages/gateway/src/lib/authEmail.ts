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

/** Lazy SMTP transporter, rebuilt when the SMTP settings change. */
let smtpTransporter: { key: string; transporter: Transporter } | null = null;

function getSmtpTransporter(): Transporter | null {
  const { authFromEmail, smtpHost, smtpPass, smtpPort, smtpUser } = resolveAuthEmailConfig();
  if (!(smtpHost && smtpPort && authFromEmail)) {
    return null;
  }
  const key = JSON.stringify([smtpHost, smtpPort, smtpUser, smtpPass]);
  if (smtpTransporter?.key !== key) {
    smtpTransporter = {
      key,
      transporter: nodemailer.createTransport({
        auth: smtpUser && smtpPass ? { pass: smtpPass, user: smtpUser } : undefined,
        host: smtpHost,
        port: smtpPort,
        // STARTTLS on 587, implicit TLS on 465. Match real-world provider defaults.
        secure: smtpPort === 465,
      }),
    };
  }
  return smtpTransporter.transporter;
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

export async function deliverAuthEmail(message: AuthEmail): Promise<void> {
  const { authFromEmail, resendApiKey } = resolveAuthEmailConfig();
  const { kind, to, subject, text, html } = message;
  const failures: string[] = [];

  const transporter = getSmtpTransporter();
  if (transporter) {
    try {
      const info = await transporter.sendMail({
        from: authFromEmail ?? undefined,
        html,
        subject,
        text,
        to,
      });
      // SMTP `sendMail` resolves on submission acceptance, not on delivery.
      // A non-empty rejected list with nothing accepted means the relay refused
      // the address even though the call "succeeded".
      if (info.rejected.length > 0 && info.accepted.length === 0) {
        throw new Error(`SMTP relay rejected the recipient: ${info.response}`);
      }
      return;
    } catch (err) {
      if (!devLogAllowed()) {
        throw err;
      }
      failures.push(`SMTP: ${(err as Error).message}`);
    }
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
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Resend returned ${res.status}: ${body.slice(0, 200)}`);
      }
      return;
    } catch (err) {
      if (!devLogAllowed()) {
        throw err;
      }
      failures.push(`Resend: ${(err as Error).message}`);
    }
  }

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
    `\n[${kind}] → ${to}\n[${kind}]   ${message.url}\n[${kind}]   (link expires in ${message.expiresIn})\n`
  );
}
