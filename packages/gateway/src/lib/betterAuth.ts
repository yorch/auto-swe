/**
 * Better Auth configuration.
 *
 * Replaces the bcrypt-password-only sign-in flow with a multi-provider
 * setup: email+password, GitHub OAuth, Google OAuth, Okta (enterprise SSO,
 * via better-auth's generic-OAuth plugin) and email magic links.
 * The existing PAT + JWT bearer paths in `plugins/auth.ts` remain unchanged
 * — those are for programmatic / CLI access. Browser sessions go through
 * better-auth's cookie-based session model.
 *
 * In dev, magic-link emails are logged to the gateway stdout (no real SMTP
 * configured). Production deployments should swap `sendMagicLink` to a real
 * transactional-email transport (Resend / SES / Mailgun / etc.).
 */

import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import {
  resolveAuthEmailConfig,
  resolveBetterAuthConfig,
  resolveGitHubConfig,
  resolveGoogleOAuthConfig,
  resolveOktaOAuthConfig,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { magicLink } from 'better-auth/plugins';
import { genericOAuth, okta } from 'better-auth/plugins/generic-oauth';
import nodemailer, { type Transporter } from 'nodemailer';

// Share the gateway's single Prisma client (one pool, tenant guard attached)
// instead of opening a second, unguarded connection pool for auth.

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const betterAuthBootstrap = resolveBetterAuthConfig();
const BASE_URL = betterAuthBootstrap.baseUrl;
const CLIENT_ORIGIN = betterAuthBootstrap.clientOrigin;

// Guard: never let the in-source dev fallback ship. The fallback is allowed
// only when NODE_ENV explicitly opts into development/test — an unset NODE_ENV
// is treated as production so a deploy that forgets it fails fast at boot
// rather than letting better-auth sign cookies with a known-public string.
const DEV_FALLBACK_SECRET =
  'dev-better-auth-secret-please-change-this-in-production-at-least-32-chars';
const DEV_SECRET_ALLOWED =
  process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
const RESOLVED_SECRET = betterAuthBootstrap.secret || DEV_FALLBACK_SECRET;
if (!DEV_SECRET_ALLOWED && RESOLVED_SECRET === DEV_FALLBACK_SECRET) {
  throw new Error(
    'BETTER_AUTH_SECRET must be set outside development/test (≥32 chars, generated with crypto rand).'
  );
}

// OAuth credentials resolved at initAuth() time (DB-primary, env-fallback).
// These are set once at startup and not re-read — changing them requires restart.
let _githubClientId: string | null = null;
let _githubClientSecret: string | null = null;
let _googleClientId: string | null = null;
let _googleClientSecret: string | null = null;
let _oktaIssuer: string | null = null;
let _oktaClientId: string | null = null;
let _oktaClientSecret: string | null = null;

/** Lazy-initialised SMTP transporter — only built when SMTP config is present
 *  AND the first magic link wants delivery. Reused across calls. */
let smtpTransporter: Transporter | null = null;
function getSmtpTransporter(): Transporter | null {
  const { authFromEmail, smtpHost, smtpPass, smtpPort, smtpUser } = resolveAuthEmailConfig();
  if (!(smtpHost && smtpPort && authFromEmail)) {
    return null;
  }
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
  const { authFromEmail, resendApiKey } = resolveAuthEmailConfig();
  const transporter = getSmtpTransporter();
  if (transporter) {
    try {
      const info = await transporter.sendMail({
        from: authFromEmail ?? undefined,
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
      if (IS_PRODUCTION) {
        throw err;
      }
      console.warn(`[magic-link] SMTP failed (${(err as Error).message}); falling back`);
    }
  }
  if (resendApiKey && authFromEmail) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        body: JSON.stringify({
          from: authFromEmail,
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
      if (IS_PRODUCTION) {
        throw err;
      }
      console.warn(`[magic-link] Resend failed (${(err as Error).message}); falling back to log`);
    }
  }
  console.log(
    `\n[magic-link] → ${email}\n[magic-link]   ${url}\n[magic-link]   (link expires in 10 min)\n`
  );
}

/**
 * Send a password-reset email. Same transport resolution as the magic link
 * (SMTP → Resend → console). The URL better-auth supplies has the reset
 * token embedded; the recipient pastes it into the /reset-password page
 * (which calls POST /api/auth/reset-password with the token + new pw).
 */
async function deliverPasswordReset({ email, url }: { email: string; url: string }): Promise<void> {
  const { authFromEmail, resendApiKey } = resolveAuthEmailConfig();
  const subject = 'Reset your auto-swe password';
  const text = `Reset your auto-swe password:\n\n${url}\n\n(This link expires in 1 hour. If you didn't request a reset, ignore this email.)`;
  const html = renderPasswordResetHtml({ email, url });

  const transporter = getSmtpTransporter();
  if (transporter) {
    try {
      const info = await transporter.sendMail({
        from: authFromEmail ?? undefined,
        html,
        subject,
        text,
        to: email,
      });
      if (info.rejected.length > 0 && info.accepted.length === 0) {
        throw new Error(`SMTP relay rejected ${email}: ${info.response}`);
      }
      return;
    } catch (err) {
      if (IS_PRODUCTION) {
        throw err;
      }
      console.warn(`[password-reset] SMTP failed (${(err as Error).message}); falling back`);
    }
  }
  if (resendApiKey && authFromEmail) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        body: JSON.stringify({ from: authFromEmail, html, subject, text, to: email }),
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(`Resend returned ${res.status}`);
      }
      return;
    } catch (err) {
      if (IS_PRODUCTION) {
        throw err;
      }
      console.warn(`[password-reset] Resend failed (${(err as Error).message}); falling back`);
    }
  }
  console.log(
    `\n[password-reset] → ${email}\n[password-reset]   ${url}\n[password-reset]   (link expires in 1 hour)\n`
  );
}

// `email` is user-controlled at sign-up; escape it (and `url`, defensively)
// before interpolating into email HTML.
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderPasswordResetHtml({
  email: rawEmail,
  url: rawUrl,
}: {
  email: string;
  url: string;
}): string {
  const email = escapeHtml(rawEmail);
  const url = escapeHtml(rawUrl);
  return `<!doctype html><html><body style="background:#0b0e13;color:#f2ede2;font-family:'IBM Plex Sans',system-ui,sans-serif;padding:32px;margin:0">
    <div style="max-width:480px;margin:auto;border:1px solid #1f2530;background:#11151d;padding:32px">
      <h1 style="font-family:'Fraunces',Georgia,serif;font-size:28px;font-weight:400;margin:0 0 16px;letter-spacing:-0.015em">Reset your password</h1>
      <p style="font-size:14px;line-height:1.5;color:#a8a395;margin:0 0 24px">
        Hi ${email}, click the button below to choose a new password. This link expires in 1 hour. If you didn't request a reset, ignore this email — your password won't change.
      </p>
      <a href="${url}" style="display:inline-block;background:#e26b3c;color:#0b0e13;text-decoration:none;padding:12px 24px;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.12em;text-transform:uppercase">Choose new password →</a>
      <p style="font-size:11px;color:#666458;margin:32px 0 0;font-family:'JetBrains Mono',monospace">
        If the button doesn't work, paste this URL into your browser:<br/>
        <span style="word-break:break-all;color:#a8a395">${url}</span>
      </p>
    </div>
  </body></html>`;
}

function renderMagicLinkHtml({
  email: rawEmail,
  url: rawUrl,
}: {
  email: string;
  url: string;
}): string {
  const email = escapeHtml(rawEmail);
  const url = escapeHtml(rawUrl);
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

// ─── Lazy singleton ───────────────────────────────────────────────────────────

type AuthInstance = ReturnType<typeof buildAuth>;
let _auth: AuthInstance | null = null;

/// Called once at gateway startup. Reads OAuth credentials from DB (with env
/// fallback) then initialises the BetterAuth singleton. Subsequent calls are
/// no-ops (the singleton is already built). A restart is required to pick up
/// changes to OAuth credentials after the server is running.
export async function initAuth(): Promise<void> {
  if (_auth) {
    return;
  }

  const [ghConfig, googleConfig, oktaConfig] = await Promise.all([
    resolveGitHubConfig(),
    resolveGoogleOAuthConfig(),
    resolveOktaOAuthConfig(),
  ]);

  _githubClientId = ghConfig.oauthClientId;
  _githubClientSecret = ghConfig.oauthClientSecret;
  _googleClientId = googleConfig.clientId;
  _googleClientSecret = googleConfig.clientSecret;
  _oktaIssuer = oktaConfig.issuer;
  _oktaClientId = oktaConfig.clientId;
  _oktaClientSecret = oktaConfig.clientSecret;

  _auth = buildAuth();
}

/// Returns the initialised BetterAuth instance. Throws if `initAuth()` hasn't
/// been called yet (should never happen in production; indicates a startup bug).
export function getAuth(): AuthInstance {
  if (!_auth) {
    throw new Error('BetterAuth not initialised — call initAuth() at gateway startup.');
  }
  return _auth;
}

/** Alias so scripts can still do `const { auth } = await import('../lib/betterAuth.js')`.
 * Note: `auth` is a function — call `auth()` to get the BetterAuth instance. */
export { getAuth as auth };

/** Okta needs all three values before the provider can be registered: the
 *  issuer drives OIDC discovery, and the client id + secret drive the code
 *  exchange. A partially-filled row leaves SSO off rather than registering a
 *  provider whose sign-in would fail at the callback.
 *
 *  The registration site in `buildAuth` repeats this condition inline rather
 *  than calling here, because only the inline form narrows the three
 *  `string | null` module-level values to `string` for `okta()`. */
function oktaConfigured(): boolean {
  return Boolean(_oktaIssuer && _oktaClientId && _oktaClientSecret);
}

function buildAuth() {
  return betterAuth({
    // Link sign-ins by verified email so a user who's already in the system
    // via GitHub and then signs in with Google (same verified email) ends up
    // attached to the existing User row instead of creating a duplicate.
    // Trusted providers skip the explicit-link-confirmation step.
    //
    // `email-password` is deliberately excluded: it is not OAuth-verified, so
    // trusting it would let an attacker who merely knows a victim's email
    // address sign up with a password under that address and auto-link onto
    // the victim's existing User row (which may have been created via a
    // verified GitHub/Google sign-in) — effectively an account-takeover via
    // credential planting. OAuth-to-OAuth linking (github <-> google) is
    // still trusted since both legs are provider-verified.
    account: {
      accountLinking: {
        enabled: true,
        // Okta joins the OAuth-verified set when configured: an enterprise IdP
        // asserts the email it returns, same as GitHub/Google, so linking onto
        // an existing User row by verified email is safe. `email-password`
        // stays out for the reason above.
        trustedProviders: oktaConfigured() ? ['github', 'google', 'okta'] : ['github', 'google'],
      },
    },
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
    // Post-create hook: auto-add new users to the configured default team so
    // team-scoped pages have something to show even before an admin has done
    // any explicit assignment. Failures are swallowed (with a server log) so a
    // missing default team doesn't block the sign-up — the user can still be
    // assigned manually.
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            try {
              // Re-read at sign-up time so admin changes to defaultTeamSlug take
              // effect immediately without a gateway restart.
              const { defaultTeamSlug } = await resolveWorkflowDefaults();
              const team = await prisma.team.findUnique({ where: { slug: defaultTeamSlug } });
              if (!team) {
                console.warn(
                  `[better-auth] default team '${defaultTeamSlug}' not found — new user ${user.email} has no team membership. Run \`yarn db:seed\` or create the team manually.`
                );
                return;
              }
              await prisma.teamMembership.upsert({
                create: { role: 'ENGINEER', teamId: team.id, userId: user.id },
                update: {},
                where: { userId_teamId: { teamId: team.id, userId: user.id } },
              });
            } catch (err) {
              console.error(
                `[better-auth] auto-team-membership hook failed for ${user.email}:`,
                err
              );
            }
          },
        },
      },
    },
    emailAndPassword: {
      autoSignIn: true,
      enabled: true,
      minPasswordLength: 8,
      // Defense-in-depth alongside the `trustedProviders` change above: an
      // unverified email+password credential can no longer be created and
      // immediately treated as equivalent to a verified OAuth identity. This
      // requires a working email-delivery transport in the deployment (SMTP
      // or Resend — see `deliverMagicLink`/`deliverPasswordReset` above); a
      // deployment with no transport configured falls back to logging the
      // link to stdout, which is dev-only and not a substitute for real
      // delivery in production. This is boot-time config read once by
      // `buildAuth()` — a gateway restart is required for a change here to
      // take effect.
      requireEmailVerification: true,
      // Reuse the same multi-transport delivery we use for magic links —
      // SMTP > Resend > console fallback. The user receives a tokenised
      // reset URL pointing at the web app's /reset-password page.
      sendResetPassword: async ({ user, url }) => deliverPasswordReset({ email: user.email, url }),
    },
    plugins: [
      magicLink({
        disableSignUp: false,
        expiresIn: 60 * 10, // 10 minutes
        sendMagicLink: async ({ email, url }) => deliverMagicLink({ email, url }),
      }),
      // Okta / enterprise SSO. `genericOAuth` registers its providers into the
      // same `socialProviders` list the built-ins live in, so `okta` is driven
      // by the ordinary `/api/auth/sign-in/social`, `/api/auth/callback/okta`
      // and `/api/auth/link-social` routes — no client-side plugin needed.
      //
      // Registered only when fully configured: the plugin's `init` fetches the
      // OIDC discovery document at gateway startup, and a half-filled row would
      // spend a boot-time round-trip to log a failure. A discovery fetch that
      // fails for a *configured* provider is logged and does not throw, so an
      // Okta outage cannot stop the gateway from booting — but Okta sign-in
      // stays broken until the gateway is restarted against a reachable
      // issuer.
      ...(_oktaIssuer && _oktaClientId && _oktaClientSecret
        ? [
            genericOAuth({
              config: [
                okta({
                  clientId: _oktaClientId,
                  clientSecret: _oktaClientSecret,
                  issuer: _oktaIssuer,
                }),
              ],
            }),
          ]
        : []),
    ],
    // Strict origins for browser-initiated calls. The Slack OAuth flow keeps
    // its own server-side redirect handling so it doesn't need to appear here.
    secret: RESOLVED_SECRET,
    socialProviders: {
      ...(_githubClientId && _githubClientSecret
        ? {
            github: { clientId: _githubClientId, clientSecret: _githubClientSecret },
          }
        : {}),
      ...(_googleClientId && _googleClientSecret
        ? {
            google: { clientId: _googleClientId, clientSecret: _googleClientSecret },
          }
        : {}),
    },
    trustedOrigins: [CLIENT_ORIGIN, BASE_URL],
    // Map better-auth's User fields onto our existing Prisma columns. The
    // legacy `password_hash` column lives on `users` for back-compat (the
    // old admin seed used it) but better-auth stores its own credential hash
    // in the Account row, so this field is optional from better-auth's POV.
    //
    // `isActive: false` is the default for new sign-ups — they sit in an
    // approval queue until an admin flips them via PATCH /api/v1/users/:id.
    // The seeded admin is pre-active via the shared seed.
    user: {
      additionalFields: {
        isActive: { defaultValue: false, input: false, required: false, type: 'boolean' },
        role: { defaultValue: 'ENGINEER', input: false, required: false, type: 'string' },
        slackId: { input: false, required: false, type: 'string' },
      },
    },
  });
}

/** Helper for the Fastify handler — exposes the auth-list of providers
 *  currently configured (used by the front-end to know which buttons to
 *  show). Read after initAuth() has been called. */
export function configuredProviders(): {
  github: boolean;
  google: boolean;
  magicLink: boolean;
  okta: boolean;
} {
  return {
    github: Boolean(_githubClientId && _githubClientSecret),
    google: Boolean(_googleClientId && _googleClientSecret),
    magicLink: true,
    okta: oktaConfigured(),
  };
}
