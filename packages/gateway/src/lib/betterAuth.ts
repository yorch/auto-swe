/**
 * Better Auth configuration.
 *
 * Replaces the bcrypt-password-only sign-in flow with a multi-provider
 * setup: email+password, GitHub OAuth, Google OAuth, and email magic links.
 * The existing PAT + JWT bearer paths in `plugins/auth.ts` remain unchanged
 * — those are for programmatic / CLI access. Browser sessions go through
 * better-auth's cookie-based session model.
 *
 * In dev, magic-link emails are logged to the gateway stdout (no real SMTP
 * configured). Production deployments should swap `sendMagicLink` to a real
 * transactional-email transport (Resend / SES / Mailgun / etc.).
 */

import crypto from 'node:crypto';
import { PrismaClient } from '@auto-swe/shared/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { magicLink } from 'better-auth/plugins';
import nodemailer, { type Transporter } from 'nodemailer';

// Reuse the same Prisma client wiring the rest of the gateway uses so we
// hit the same connection pool.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const BASE_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:8080';
const CLIENT_ORIGIN = process.env.CORS_ORIGIN?.split(',')[0]?.trim() ?? 'http://localhost:3000';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Production guard: never let the in-source dev fallback ship. Failing fast
// here surfaces missing secrets at boot time rather than letting better-auth
// sign cookies with a known-public string.
const DEV_FALLBACK_SECRET =
  'dev-better-auth-secret-please-change-this-in-production-at-least-32-chars';
const RESOLVED_SECRET = process.env.BETTER_AUTH_SECRET ?? DEV_FALLBACK_SECRET;
if (IS_PRODUCTION && RESOLVED_SECRET === DEV_FALLBACK_SECRET) {
  throw new Error(
    'BETTER_AUTH_SECRET must be set in production (≥32 chars, generated with crypto rand).'
  );
}

const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

const resendApiKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.AUTH_FROM_EMAIL;
const smtpHost = process.env.SMTP_HOST;
const smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;

/** Lazy-initialised SMTP transporter — only built when SMTP env is present
 *  AND the first magic link wants delivery. Reused across calls. */
let smtpTransporter: Transporter | null = null;
function getSmtpTransporter(): Transporter | null {
  if (!(smtpHost && smtpPort && fromEmail)) return null;
  if (!smtpTransporter) {
    smtpTransporter = nodemailer.createTransport({
      auth: smtpUser && smtpPass ? { pass: smtpPass, user: smtpUser } : undefined,
      host: smtpHost,
      port: smtpPort,
      // STARTTLS on 587, implicit TLS on 465. Match real-world provider defaults.
      secure: smtpPort === 465,
    });
  }
  return smtpTransporter;
}

/**
 * Send a magic-link email. Resolves the transport from env at call time so
 * tests / dev can swap behaviour without restarting. Resolution order:
 *
 *   1. SMTP_HOST + SMTP_PORT + AUTH_FROM_EMAIL → nodemailer (covers Mailgun,
 *      Postmark, SES via SMTP creds, self-hosted Postfix, etc.)
 *   2. RESEND_API_KEY + AUTH_FROM_EMAIL → POST to Resend (HTTP API)
 *   3. Else → console.log (dev convenience; URL for copy-paste)
 *
 * Production deployments must configure one of the real transports — the
 * console fallback is a dev-only convenience.
 */
async function deliverMagicLink({ email, url }: { email: string; url: string }): Promise<void> {
  const transporter = getSmtpTransporter();
  if (transporter) {
    try {
      const info = await transporter.sendMail({
        from: fromEmail,
        html: renderMagicLinkHtml({ email, url }),
        subject: 'Your auto-swe sign-in link',
        text: `Sign in to auto-swe:\n\n${url}\n\n(This link expires in 10 minutes.)`,
        to: email,
      });
      // SMTP `sendMail` resolves on submission acceptance, not on delivery.
      // Inspect `accepted` / `rejected` to distinguish — a non-empty rejected
      // list means the relay refused the address even though the call
      // "succeeded". See the `nodemailer-sendmail-accepted-vs-delivered` skill.
      if (info.rejected.length > 0 && info.accepted.length === 0) {
        throw new Error(`SMTP relay rejected ${email}: ${info.response}`);
      }
      return;
    } catch (err) {
      if (IS_PRODUCTION) throw err;
      // biome-ignore lint/suspicious/noConsole: dev-only diagnostic when SMTP fails
      console.warn(`[magic-link] SMTP failed (${(err as Error).message}); falling back`);
    }
  }
  if (resendApiKey && fromEmail) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        body: JSON.stringify({
          from: fromEmail,
          html: renderMagicLinkHtml({ email, url }),
          subject: 'Your auto-swe sign-in link',
          text: `Sign in to auto-swe:\n\n${url}\n\n(This link expires in 10 minutes.)`,
          to: email,
        }),
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
      if (IS_PRODUCTION) throw err;
      // biome-ignore lint/suspicious/noConsole: dev-only diagnostic when Resend fails
      console.warn(`[magic-link] Resend failed (${(err as Error).message}); falling back to log`);
    }
  }
  // biome-ignore lint/suspicious/noConsole: dev-only magic-link delivery
  console.log(
    `\n[magic-link] → ${email}\n[magic-link]   ${url}\n[magic-link]   (link expires in 10 min)\n`
  );
}

function renderMagicLinkHtml({ email, url }: { email: string; url: string }): string {
  // Plain, inline-styled HTML so it renders identically across mail clients
  // without external CSS. Matches the workshop-telemetry aesthetic.
  return `<!doctype html><html><body style="background:#0b0e13;color:#f2ede2;font-family:'IBM Plex Sans',system-ui,sans-serif;padding:32px;margin:0">
    <div style="max-width:480px;margin:auto;border:1px solid #1f2530;background:#11151d;padding:32px">
      <h1 style="font-family:'Fraunces',Georgia,serif;font-size:28px;font-weight:400;margin:0 0 16px;letter-spacing:-0.015em">Sign in to auto-swe</h1>
      <p style="font-size:14px;line-height:1.5;color:#a8a395;margin:0 0 24px">
        Hi ${email}, click the button below to sign in. This link expires in 10 minutes.
      </p>
      <a href="${url}" style="display:inline-block;background:#e26b3c;color:#0b0e13;text-decoration:none;padding:12px 24px;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.12em;text-transform:uppercase">Sign in →</a>
      <p style="font-size:11px;color:#666458;margin:32px 0 0;font-family:'JetBrains Mono',monospace">
        If the button doesn't work, paste this URL into your browser:<br/>
        <span style="word-break:break-all;color:#a8a395">${url}</span>
      </p>
    </div>
  </body></html>`;
}

export const auth = betterAuth({
  // Cookies on the gateway need to be readable by the browser running on
  // a different port. SameSite=Lax is sufficient for top-level GET nav and
  // OAuth callbacks; Secure flips on automatically under HTTPS.
  advanced: {
    crossSubDomainCookies: { enabled: false },
    // Our existing schema uses `@db.Uuid` for every primary key (User row
    // pre-dates better-auth and is referenced by half the system); the
    // better-auth tables we just added follow the same convention. Override
    // better-auth's default nanoid generator to emit RFC-4122 UUIDs so the
    // Postgres `uuid` column accepts them on insert.
    database: { generateId: () => crypto.randomUUID() },
    defaultCookieAttributes: {
      sameSite: 'lax',
      secure: BASE_URL.startsWith('https://'),
    },
  },
  baseURL: BASE_URL,
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: {
    autoSignIn: true,
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: false,
  },
  plugins: [
    magicLink({
      disableSignUp: false,
      expiresIn: 60 * 10, // 10 minutes
      sendMagicLink: async ({ email, url }) => deliverMagicLink({ email, url }),
    }),
  ],
  // Strict origins for browser-initiated calls. The Slack OAuth flow keeps
  // its own server-side redirect handling so it doesn't need to appear here.
  secret: RESOLVED_SECRET,
  socialProviders: {
    ...(githubClientId && githubClientSecret
      ? {
          github: { clientId: githubClientId, clientSecret: githubClientSecret },
        }
      : {}),
    ...(googleClientId && googleClientSecret
      ? {
          google: { clientId: googleClientId, clientSecret: googleClientSecret },
        }
      : {}),
  },
  trustedOrigins: [CLIENT_ORIGIN, BASE_URL],
  // Map better-auth's User fields onto our existing Prisma columns. The
  // legacy `password_hash` column lives on `users` for back-compat (the
  // old admin seed used it) but better-auth stores its own credential hash
  // in the Account row, so this field is optional from better-auth's POV.
  user: {
    additionalFields: {
      isActive: { defaultValue: true, input: false, required: false, type: 'boolean' },
      role: { defaultValue: 'ENGINEER', input: false, required: false, type: 'string' },
      slackId: { input: false, required: false, type: 'string' },
    },
  },
});

/** Helper for the Fastify handler — exposes the auth-list of providers
 *  currently configured (used by the front-end to know which buttons to
 *  show). The presence of credentials in env decides what we advertise. */
export function configuredProviders(): { github: boolean; google: boolean; magicLink: boolean } {
  return {
    github: Boolean(githubClientId && githubClientSecret),
    google: Boolean(googleClientId && googleClientSecret),
    magicLink: true,
  };
}
