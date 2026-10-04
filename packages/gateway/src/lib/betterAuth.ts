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
 * Magic-link and password-reset emails go out through `authEmail.ts` (SMTP or
 * Resend). Only in development/test does an unconfigured transport fall back
 * to printing the link to stdout; elsewhere it fails without logging the URL.
 */

import crypto from 'node:crypto';
import { resolveSettings } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { isSafeProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import {
  resolveBetterAuthConfig,
  resolveGitHubConfig,
  resolveGoogleOAuthConfig,
  resolveOktaOAuthConfig,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import { oauthProvider } from '@better-auth/oauth-provider';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError } from 'better-auth/api';
import { jwt, magicLink } from 'better-auth/plugins';
import { type GenericOAuthConfig, genericOAuth, okta } from 'better-auth/plugins/generic-oauth';
import { authEmailAvailable, deliverAuthEmail } from './authEmail.js';
import { type GithubSignIn, resolveGithubSignIn } from './githubEnterpriseAuth.js';
import { clearGithubLogin, syncGithubLoginForAccount } from './githubIdentity.js';
import {
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_JWKS_GRACE_SECONDS,
  MCP_JWKS_ROTATION_SECONDS,
  MCP_REFRESH_TOKEN_TTL_SECONDS,
  MCP_SCOPES,
  mcpIssuanceRefusal,
  mcpIssuerFor,
  mcpResourceFor,
} from './mcpOAuth.js';

// Share the gateway's single Prisma client (one pool, tenant guard attached)
// instead of opening a second, unguarded connection pool for auth.

const betterAuthBootstrap = resolveBetterAuthConfig();
const BASE_URL = betterAuthBootstrap.baseUrl;
const CLIENT_ORIGIN = betterAuthBootstrap.clientOrigin;

/// The MCP resource server's identifier (RFC 8707): the `aud` of every access token this
/// authorization server issues for MCP clients.
export const MCP_RESOURCE = mcpResourceFor(BASE_URL);
/// The `iss` of those tokens, and the authorization server a client is pointed at.
export const MCP_ISSUER = mcpIssuerFor(BASE_URL);

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
let _githubSignIn: GithubSignIn = { mode: 'none' };
let _googleClientId: string | null = null;
let _googleClientSecret: string | null = null;
let _oktaIssuer: string | null = null;
let _oktaClientId: string | null = null;
let _oktaClientSecret: string | null = null;

/**
 * Send a magic-link email. Transport resolution — and the rule that the URL is
 * only ever printed in development/test — lives in `deliverAuthEmail`.
 */
async function deliverMagicLink({ email, url }: { email: string; url: string }): Promise<void> {
  await deliverAuthEmail({
    expiresIn: '10 min',
    html: renderMagicLinkHtml({ email, url }),
    kind: 'magic-link',
    subject: 'Your auto-swe sign-in link',
    text: `Sign in to auto-swe:\n\n${url}\n\n(This link expires in 10 minutes.)`,
    to: email,
    url,
  });
}

/**
 * Send a password-reset email. The URL better-auth supplies has the reset
 * token embedded; the recipient pastes it into the /reset-password page
 * (which calls POST /api/auth/reset-password with the token + new pw).
 */
async function deliverPasswordReset({ email, url }: { email: string; url: string }): Promise<void> {
  await deliverAuthEmail({
    expiresIn: '1 hour',
    html: renderPasswordResetHtml({ email, url }),
    kind: 'password-reset',
    subject: 'Reset your auto-swe password',
    text: `Reset your auto-swe password:\n\n${url}\n\n(This link expires in 1 hour. If you didn't request a reset, ignore this email.)`,
    to: email,
    url,
  });
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

/// Called once at gateway startup. Reads the sign-in credentials from the
/// environment (GitHub's endpoints still come from the GitHub config row), then
/// initialises the BetterAuth singleton. Subsequent calls are no-ops (the
/// singleton is already built). A restart is required to pick up changes to
/// OAuth credentials after the server is running.
export async function initAuth(): Promise<void> {
  if (_auth) {
    return;
  }

  const ghConfig = await resolveGitHubConfig();
  const googleConfig = resolveGoogleOAuthConfig();
  const oktaConfig = resolveOktaOAuthConfig();

  _githubSignIn = resolveGithubSignIn({
    apiUrl: ghConfig.apiUrl,
    baseUrl: ghConfig.baseUrl,
    clientId: ghConfig.oauthClientId,
    clientSecret: ghConfig.oauthClientSecret,
  });
  _googleClientId = googleConfig.clientId;
  _googleClientSecret = googleConfig.clientSecret;
  const oktaIssuerProblem = oktaConfig.issuer ? checkOktaIssuer(oktaConfig.issuer) : null;
  if (oktaIssuerProblem) {
    // Refuse the provider, not the gateway: a bad issuer must not take down
    // email and the other sign-in methods. Okta stays off until it is fixed.
    console.error(
      `[better-auth] Okta sign-in disabled: OKTA_ISSUER rejected (${oktaIssuerProblem}).`
    );
  }
  _oktaIssuer = oktaIssuerProblem ? null : oktaConfig.issuer;
  _oktaClientId = oktaConfig.clientId;
  _oktaClientSecret = oktaConfig.clientSecret;

  _auth = buildAuth();
}

/// The issuer's discovery document is fetched server-side at boot, so it gets
/// the same SSRF guard as every other operator-supplied URL: public HTTPS only.
/// The issuer comes from the environment, so only whoever controls the
/// deployment can set it — this catches a mistake, not an attacker.
/// Returns why the issuer is unusable, or null when it is fine.
function checkOktaIssuer(issuer: string): string | null {
  const safety = isSafeProbeUrl(issuer);
  if (!safety.ok) {
    return safety.reason;
  }
  if (safety.url.protocol !== 'https:') {
    return 'must use https';
  }
  return null;
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
  // One `genericOAuth` plugin carries every provider the built-in adapters cannot: GitHub
  // Enterprise (registered under the `github` id) and Okta.
  const genericConfigs: GenericOAuthConfig[] = [];
  if (_githubSignIn.mode === 'ghe') {
    genericConfigs.push(_githubSignIn.config);
  }
  if (_oktaIssuer && _oktaClientId && _oktaClientSecret) {
    genericConfigs.push(
      okta({ clientId: _oktaClientId, clientSecret: _oktaClientSecret, issuer: _oktaIssuer })
    );
  }

  /**
   * Record (or re-record) the GitHub username behind a linked GitHub account.
   *
   * Runs on link and on every account update. Swallowed on failure, like the
   * team hook below: the repo-permission projection needs this login, but a
   * GitHub outage must not stop someone signing in. An unresolved user shows up
   * in the advisory-mode logs.
   */
  const refreshGithubLogin = async (account: {
    providerId: string;
    userId: string;
    accountId?: string | null;
    accessToken?: string | null;
  }): Promise<void> => {
    if (account.providerId !== 'github') {
      return;
    }
    try {
      // In GHE mode use the API URL sign-in itself resolved: with only a Base URL saved the saved
      // API URL is still api.github.com, which would receive the user's GHE access token.
      const apiUrl =
        _githubSignIn.mode === 'ghe' ? _githubSignIn.apiUrl : (await resolveGitHubConfig()).apiUrl;
      const result = await syncGithubLoginForAccount(prisma, {
        accessToken: account.accessToken,
        accountId: account.accountId ?? null,
        apiUrl,
        userId: account.userId,
      });
      if (!result.login) {
        console.warn(
          `[better-auth] could not record a GitHub login for user ${account.userId} (${result.reason}); repository permission checks cannot resolve this user until it is set.`
        );
      }
    } catch (err) {
      console.error(`[better-auth] github-login hook failed for user ${account.userId}:`, err);
    }
  };

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
      // Cookie-authenticated POSTs (the OAuth consent decision among them) are refused unless
      // their Origin is trusted. better-auth switches that check off under test runners
      // unless it is pinned, which would leave the suites unable to see a CSRF regression.
      disableOriginCheck: false,
    },
    baseURL: BASE_URL,
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    // Post-create hook: auto-add new users to the configured default team so
    // team-scoped pages have something to show even before an admin has done
    // any explicit assignment. Failures are swallowed (with a server log) so a
    // missing default team doesn't block the sign-up — the user can still be
    // assigned manually.
    databaseHooks: {
      // Post-create hook: capture the GitHub username behind a newly linked
      // GitHub account. This fires both when a GitHub sign-in creates a user
      // and when an existing user links GitHub later, which is why it hangs off
      // the account rather than the user — the second case creates no user row.
      //
      // Swallowed on failure, like the team hook below: the repo-permission
      // projection needs this login, but a GitHub outage must not stop someone
      // signing in. An unresolved user shows up in the advisory-mode logs.
      account: {
        create: { after: async (account) => refreshGithubLogin(account) },
        // Unlinking must forget the identity. A login left behind keeps
        // resolving repository permissions for an account that is no longer
        // connected to this user at all.
        delete: {
          after: async (account) => {
            if (account.providerId !== 'github') {
              return;
            }
            try {
              await clearGithubLogin(prisma, account.userId);
            } catch (err) {
              console.error(
                `[better-auth] failed to clear the GitHub login for user ${account.userId} on unlink; it may still authorise repository access:`,
                err
              );
            }
          },
        },
        // Re-verified on every account update, not only on create.
        // `updateAccountOnSignIn` refreshes the stored token on each GitHub
        // sign-in, so this is where a renamed GitHub account gets picked up.
        // Without it the login is frozen at link time, and GitHub usernames are
        // released on rename and immediately re-registrable — a stale one can
        // eventually name a different person while still backing this user's
        // repository access.
        update: { after: async (account) => refreshGithubLogin(account) },
      },
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
      // Okta / enterprise SSO, and GitHub Enterprise (see `genericConfigs`).
      // `genericOAuth` registers its providers into the same `socialProviders`
      // list the built-ins live in, so `okta` is driven
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
      ...(genericConfigs.length > 0 ? [genericOAuth({ config: genericConfigs })] : []),
      // OAuth 2.1 authorization server for MCP clients. Everything below derives from
      // BASE_URL / CORS_ORIGIN, so it is configured once here; the operator switches
      // (`mcp.enabled`, `mcp.writeToolsEnabled`) and every request-level policy live in the
      // Fastify gate (`mcpOAuthGate.ts`), which reads settings per request.
      //
      // `disableSettingJwtHeader`: without it the plugin signs the full session user (email,
      // role, `isActive`, `slackId`) into a `set-auth-jwt` header on every `/get-session`.
      jwt({
        disableSettingJwtHeader: true,
        jwks: { gracePeriod: MCP_JWKS_GRACE_SECONDS, rotationInterval: MCP_JWKS_ROTATION_SECONDS },
        jwt: { issuer: mcpIssuerFor(BASE_URL) },
      }),
      oauthProvider({
        accessTokenExpiresIn: MCP_ACCESS_TOKEN_TTL_SECONDS,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // The plugin's default lets any signed-in session create, update, delete and rotate
        // clients; new sign-ups exist (inactive) and magic-link sign-up is on. There is no
        // client-management UI, so deny, for clients and for resources alike.
        clientPrivileges: () => false,
        // A DCR client may ask for these and nothing else.
        clientRegistrationAllowedScopes: [...MCP_SCOPES],
        // `enforcePerClientResources` defaults to true, and a DCR client is otherwise linked to
        // no resource, so its authorize request fails with `invalid_target`. Do not turn the
        // enforcement off instead.
        clientRegistrationDefaultResources: [MCP_RESOURCE],
        consentPage: `${CLIENT_ORIGIN}/oauth/consent`,
        // Runs on every JWT access-token mint, for the code and the refresh grant, before any
        // refresh token is stored or rotated, so a throw here issues nothing. This is the one
        // place every path crosses, including an authorization resumed after sign-in. The
        // plugin's opaque, audience-less token path skips it; the gate makes that path
        // unreachable by requiring `resource` at authorize and at the token endpoint.
        customAccessTokenClaims: async ({ scopes, user }) => {
          const settings = await resolveSettings(['mcp.enabled', 'mcp.writeToolsEnabled']);
          const refusal = mcpIssuanceRefusal(user, scopes, {
            enabled: settings['mcp.enabled'],
            writeToolsEnabled: settings['mcp.writeToolsEnabled'],
          });
          if (refusal) {
            throw new APIError('BAD_REQUEST', {
              error: 'invalid_grant',
              error_description: refusal,
            });
          }
          return {};
        },
        // Public clients only, so the default `client_credentials` grant goes.
        grantTypes: ['authorization_code', 'refresh_token'],
        loginPage: `${CLIENT_ORIGIN}/login`,
        refreshTokenExpiresIn: MCP_REFRESH_TOKEN_TTL_SECONDS,
        resourcePrivileges: () => false,
        // The plugin intersects requested scopes with the resource's list, so
        // `offline_access` must be listed here or the refresh-token scope is filtered back out.
        // An absent list means "unrestricted" and an empty one "nothing allowed".
        // The configuration is the only source of truth (no admin editing of resources), so a
        // change to the scopes must reach a row that already exists.
        resourceSeedMode: 'overwrite',
        resources: [
          { allowedScopes: [...MCP_SCOPES], identifier: MCP_RESOURCE, name: 'auto-swe MCP' },
        ],
        // `offline_access` is what makes the plugin issue a refresh token.
        scopes: [...MCP_SCOPES],
      }),
    ],
    // Strict origins for browser-initiated calls. The Slack OAuth flow keeps
    // its own server-side redirect handling so it doesn't need to appear here.
    secret: RESOLVED_SECRET,
    socialProviders: {
      ...(_githubSignIn.mode === 'builtin'
        ? {
            github: {
              clientId: _githubSignIn.clientId,
              clientSecret: _githubSignIn.clientSecret,
            },
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
        // Written by the account-create hook above, never by a client — a user
        // who could set their own GitHub login could claim another person's
        // repository access.
        githubLogin: { input: false, required: false, type: 'string' },
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
    github: _githubSignIn.mode !== 'none',
    google: Boolean(_googleClientId && _googleClientSecret),
    magicLink: authEmailAvailable(),
    okta: oktaConfigured(),
  };
}
