import crypto from 'node:crypto';
import { encryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  resolvePublicUrl,
  resolveSlackConfig,
  resolveWebUrl,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import type { FastifyInstance } from 'fastify';
import { requireAuth, requireUser } from '../../plugins/auth.js';

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  /** User-token grant (account-link `/connect` flow, scope `identity.basic`). */
  authed_user: { access_token: string };
  /** Bot-token grant (app-install `/install` flow). Top-level `access_token` is
   *  the `xoxb-…` bot token; `team`/`app_id`/`bot_user_id` identify the install. */
  access_token?: string;
  app_id?: string;
  bot_user_id?: string;
  team?: { id?: string; name?: string };
}

/**
 * Bot scopes requested at app install (Full multi-workspace). Mirrors
 * `docs/slack-app-setup.md` § Bot scopes — kept in sync with the app manifest so
 * the granted token can drive every Slack surface (posts, history, mentions,
 * DMs, slash commands, App Home).
 */
const SLACK_INSTALL_BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'chat:write',
  'chat:write.public',
  'commands',
  'groups:history',
  'im:history',
  'users:read',
  'users:read.email',
].join(',');

/**
 * Exchange a Slack OAuth `code` for tokens via `oauth.v2.access`. Shared by the
 * account-link (`/callback`) and app-install (`/install/callback`) flows, which
 * differ only in the scopes requested and which token field they read back
 * (`authed_user.access_token` vs. the top-level bot `access_token`).
 */
async function exchangeSlackOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<SlackOAuthResponse> {
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
  return (await res.json()) as SlackOAuthResponse;
}

/**
 * The cookie that binds an account-link flow to the browser that started it.
 *
 * The signed `state` says who started the flow, but not who finishes it: a
 * started flow's Slack authorize URL handed to someone else would link *their*
 * Slack account to the starter's platform user. So `/connect` also puts a
 * random nonce in the state and in this cookie, and the callback requires both
 * to agree. The callback is a top-level GET navigation back from Slack to the
 * gateway's own host, which a `SameSite=Lax` cookie is sent on.
 */
const SLACK_LINK_COOKIE = 'auto_swe_slack_link';
/** Matches the state token's lifetime: a flow cannot outlive either. */
const SLACK_LINK_COOKIE_MAX_AGE_S = 10 * 60;

/**
 * The bot-install flow's own binding cookie. Same reasoning as the link cookie: the
 * signed state names the admin who started the install, not the browser that finishes
 * it, and the install writes a workspace bot token.
 */
const SLACK_INSTALL_COOKIE = 'auto_swe_slack_install';
const SLACK_INSTALL_CALLBACK_PATH = '/api/v1/auth/slack/install/callback';

/** A flow callback URL (default: the account-link one), and cookie options scoped to its path. */
function slackLinkCallback(path = '/api/v1/auth/slack/callback'): {
  redirectUri: string;
  cookie: { httpOnly: true; path: string; sameSite: 'lax'; secure: boolean };
} {
  const redirectUri = `${resolvePublicUrl()}${path}`;
  const url = new URL(redirectUri);
  return {
    cookie: {
      httpOnly: true,
      path: url.pathname,
      sameSite: 'lax',
      secure: url.protocol === 'https:',
    },
    redirectUri,
  };
}

/** Constant-time string equality; false for any length mismatch. */
function sameNonce(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

interface SlackIdentityResponse {
  ok: boolean;
  user: { id: string };
}

export async function registerOauthRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/v1/auth/slack/connect — Initiate Slack OAuth (authenticated users only)
  fastify.get(
    '/connect',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
    },
    async (request, reply) => {
      const { clientId } = await resolveSlackConfig();
      if (!clientId) {
        return reply.status(503).send({
          error: { code: 'SLACK_NOT_CONFIGURED', message: 'Slack integration not configured' },
        });
      }

      const user = requireUser(request);
      // Single-purpose, short-lived state token (not an API access token) so a
      // leak via Slack logs / Referer / browser history can't be replayed as a
      // bearer credential. The nonce binds it to this browser (SLACK_LINK_COOKIE).
      const nonce = crypto.randomBytes(32).toString('base64url');
      const state = fastify.auth.signOAuthState(user.sub, 'slack-link', nonce);

      const { cookie, redirectUri } = slackLinkCallback();
      // We link by Slack user id only; identity.basic is sufficient.
      const scopes = 'identity.basic';

      const url = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;

      reply.setCookie(SLACK_LINK_COOKIE, nonce, {
        ...cookie,
        maxAge: SLACK_LINK_COOKIE_MAX_AGE_S,
      });
      return reply.redirect(url);
    }
  );

  // GET /api/v1/auth/slack/callback — Handle Slack OAuth callback
  fastify.get('/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };
    // The flow must finish in the browser that started it (SLACK_LINK_COOKIE).
    // One use only: the cookie is cleared whatever the outcome, a cancelled or
    // malformed callback included.
    const { cookie, redirectUri } = slackLinkCallback();
    const browserNonce = request.cookies[SLACK_LINK_COOKIE];
    reply.clearCookie(SLACK_LINK_COOKIE, cookie);

    if (!code || !state) {
      return reply.status(400).send({
        error: { code: 'INVALID_CALLBACK', message: 'Missing code or state' },
      });
    }

    // Verify the single-purpose OAuth state token.
    let statePayload: { sub: string; nonce?: string };
    try {
      statePayload = fastify.auth.verifyOAuthState(state, 'slack-link');
    } catch {
      return reply.status(400).send({
        error: { code: 'INVALID_STATE', message: 'Invalid state parameter' },
      });
    }

    if (!(statePayload.nonce && browserNonce && sameNonce(statePayload.nonce, browserNonce))) {
      return reply.status(403).send({
        error: {
          code: 'STATE_MISMATCH',
          message:
            'This Slack link was not started in this browser. Start it again from your settings page.',
        },
      });
    }
    // The state is up to ten minutes old; the account it names must still be
    // one that may sign in.
    const linkingUser = await fastify.prisma.user.findUnique({
      select: { isActive: true },
      where: { id: statePayload.sub },
    });
    if (!linkingUser?.isActive) {
      return reply.status(403).send({
        error: { code: 'USER_INACTIVE', message: 'User account is not active' },
      });
    }

    const { clientId, clientSecret } = await resolveSlackConfig();
    if (!clientId || !clientSecret) {
      return reply.status(503).send({
        error: { code: 'SLACK_NOT_CONFIGURED', message: 'Slack OAuth credentials missing' },
      });
    }
    const tokenData = await exchangeSlackOAuthCode(clientId, clientSecret, code, redirectUri);
    if (!tokenData.ok) {
      return reply.status(400).send({
        error: { code: 'SLACK_AUTH_FAILED', message: tokenData.error ?? 'Slack OAuth failed' },
      });
    }

    // Get user identity
    const identityResponse = await fetch('https://slack.com/api/users.identity', {
      headers: { Authorization: `Bearer ${tokenData.authed_user.access_token}` },
    });

    const identity = (await identityResponse.json()) as SlackIdentityResponse;
    if (!identity.ok) {
      return reply.status(400).send({
        error: { code: 'SLACK_IDENTITY_FAILED', message: 'Failed to get Slack identity' },
      });
    }

    const slackId = identity.user.id;

    // Prevent double-linking
    const existingLink = await fastify.prisma.user.findFirst({
      where: { id: { not: statePayload.sub }, slackId },
    });
    if (existingLink) {
      return reply.status(409).send({
        error: {
          code: 'SLACK_ALREADY_LINKED',
          message: 'This Slack account is linked to another user',
        },
      });
    }

    // Update user with Slack ID
    await fastify.prisma.user.update({
      data: { slackId },
      where: { id: statePayload.sub },
    });

    return { data: { connected: true, slackId } };
  });

  // ── App install (Full multi-workspace) ──────────────────────────────────────
  //
  // Distinct from the account-link `/connect` flow above: `/install` requests BOT
  // scopes and captures the per-workspace `xoxb-…` bot token, so the single Slack
  // app can be installed into many workspaces and each workspace's Slack I/O uses
  // its own token. The bot token is the only per-workspace secret; the signing
  // secret + OAuth client id/secret stay singleton in `SlackConfig`.

  // GET /api/v1/auth/slack/install — Begin the bot-install OAuth flow (admins).
  fastify.get(
    '/install',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
    },
    async (request, reply) => {
      const { clientId } = await resolveSlackConfig();
      if (!clientId) {
        return reply.status(503).send({
          error: { code: 'SLACK_NOT_CONFIGURED', message: 'Slack OAuth client id not configured' },
        });
      }
      const user = requireUser(request);
      // Single-purpose, short-lived signed state (not a bearer credential). The nonce
      // binds it to this browser (SLACK_INSTALL_COOKIE).
      const nonce = crypto.randomBytes(32).toString('base64url');
      const state = fastify.auth.signOAuthState(user.sub, 'slack-install', nonce);
      const { cookie, redirectUri } = slackLinkCallback(SLACK_INSTALL_CALLBACK_PATH);
      const url = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${encodeURIComponent(SLACK_INSTALL_BOT_SCOPES)}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
      reply.setCookie(SLACK_INSTALL_COOKIE, nonce, {
        ...cookie,
        maxAge: SLACK_LINK_COOKIE_MAX_AGE_S,
      });
      return reply.redirect(url);
    }
  );

  // GET /api/v1/auth/slack/install/callback — Complete the bot install: exchange
  // the code for the workspace bot token and persist it encrypted on the
  // workspace row. Redirects back to the admin integrations page on success.
  fastify.get('/install/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };
    // The install must finish in the browser that started it (SLACK_INSTALL_COOKIE).
    // One use only: cleared whatever the outcome.
    const { cookie, redirectUri } = slackLinkCallback(SLACK_INSTALL_CALLBACK_PATH);
    const browserNonce = request.cookies[SLACK_INSTALL_COOKIE];
    reply.clearCookie(SLACK_INSTALL_COOKIE, cookie);

    if (!code || !state) {
      return reply.status(400).send({
        error: { code: 'INVALID_CALLBACK', message: 'Missing code or state' },
      });
    }
    let installerId: string;
    let stateNonce: string | undefined;
    try {
      const payload = fastify.auth.verifyOAuthState(state, 'slack-install');
      installerId = payload.sub;
      stateNonce = payload.nonce;
    } catch {
      return reply.status(400).send({
        error: { code: 'INVALID_STATE', message: 'Invalid state parameter' },
      });
    }
    if (!(stateNonce && browserNonce && sameNonce(stateNonce, browserNonce))) {
      return reply.status(403).send({
        error: {
          code: 'STATE_MISMATCH',
          message:
            'This install was not started in this browser. Start it again from the admin page.',
        },
      });
    }
    // The state proves who started the flow; re-check that they are still an
    // active platform admin at completion time so a demoted or deactivated
    // account (or a state token from a lesser flow) cannot bind a bot token.
    const installer = await fastify.prisma.user.findUnique({
      select: { isActive: true, role: true },
      where: { id: installerId },
    });
    if (!installer?.isActive || installer.role !== 'ADMIN') {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Only active platform admins may install the bot' },
      });
    }

    const { clientId, clientSecret } = await resolveSlackConfig();
    if (!clientId || !clientSecret) {
      return reply.status(503).send({
        error: { code: 'SLACK_NOT_CONFIGURED', message: 'Slack OAuth credentials missing' },
      });
    }
    const tokenData = await exchangeSlackOAuthCode(clientId, clientSecret, code, redirectUri);
    // A bot install returns the bot token as the top-level `access_token` plus the
    // installing `team`. Bail clearly if either is missing (e.g. a user-scope grant).
    if (!tokenData.ok || !tokenData.access_token || !tokenData.team?.id) {
      return reply.status(400).send({
        error: {
          code: 'SLACK_INSTALL_FAILED',
          message: tokenData.error ?? 'Slack did not return a workspace bot token',
        },
      });
    }

    const slackTeamId = tokenData.team.id;
    const sealed = encryptSecret(tokenData.access_token);
    const tokenColumns = {
      botTokenAuthTag: sealed.authTag,
      botTokenCiphertext: sealed.ciphertext,
      botTokenKeyVersion: sealed.keyVersion,
      botTokenLastFour: sealed.lastFour,
      botTokenNonce: sealed.nonce,
      ...(tokenData.app_id ? { appId: tokenData.app_id } : {}),
      ...(tokenData.bot_user_id ? { botUserId: tokenData.bot_user_id } : {}),
      installedAt: new Date(),
      ...(tokenData.team.name ? { name: tokenData.team.name } : {}),
    };

    // Existing workspace → store the token. New workspace → create under the
    // default team's org (mirrors event-time auto-provisioning) so a first-ever
    // install needs no prior event.
    const existing = await fastify.prisma.slackWorkspace.findUnique({ where: { slackTeamId } });
    if (existing) {
      await fastify.prisma.slackWorkspace.update({
        data: tokenColumns,
        where: { slackTeamId },
      });
    } else {
      const { defaultTeamSlug } = await resolveWorkflowDefaults();
      const defaultTeam = await fastify.prisma.team.findUnique({
        where: { slug: defaultTeamSlug },
      });
      if (!defaultTeam) {
        return reply.status(503).send({
          error: {
            code: 'DEFAULT_TEAM_MISSING',
            message: 'No default team — run `yarn db:seed` before installing into a new workspace',
          },
        });
      }
      await fastify.prisma.slackWorkspace.create({
        data: { ...tokenColumns, orgId: defaultTeam.orgId, slackTeamId },
      });
    }

    // Bounce back to the integrations page with a success flag; its Slack tab
    // reads `tab` and `slack_installed`.
    return reply.redirect(
      `${resolveWebUrl()}/admin/integrations?tab=slack&slack_installed=${slackTeamId}`
    );
  });
}
