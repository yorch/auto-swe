import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { CHANNEL_TASK_STEER_SIGNAL, channelTaskWorkflowId } from '@auto-swe/shared/lib/channelTask';
import { isGitRepoConnection } from '@auto-swe/shared/lib/connectionGuards';
import { encryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  decideRepoAccess,
  REPO_ACCESS_REFUSAL_MESSAGE,
} from '@auto-swe/shared/lib/repoAccessDecision';
import { resolveRepoAccessGateOrLastKnown } from '@auto-swe/shared/lib/repoAccessGate';
import {
  resolvePublicUrl,
  resolveSlackBotTokenForSlackChannel,
  resolveSlackBotTokenForWorkspace,
  resolveSlackConfig,
  resolveWebUrl,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import { generateBranchName, generateWorkflowId } from '@auto-swe/shared/lib/workflowId';
import type { ChannelAssistantTurnInput, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { type HitlResolveErrorCode, resolveHitlStep } from '../lib/hitlResolve.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { buildWorkflowRunVisibilityFilter } from '../lib/runVisibility.js';
import {
  fetchSlackChannelIsPrivate,
  openSlackView,
  postSlackMessage,
  publishAppHome,
  verifySlackSignature,
} from '../lib/slack.js';
import { isTerminalSignalError } from '../lib/temporalErrors.js';
import { memberTeams, reachableConnections } from '../lib/tenantScope.js';
import { launchTrackedWorkflow } from '../lib/workflowLaunch.js';
import { getErrorName, hasRole, requireAuth, requireUser } from '../plugins/auth.js';
import { resolveDefaultTemplate } from './workRequests.js';

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

interface SlackIdentityResponse {
  ok: boolean;
  user: { id: string };
}

interface SlackInteractivePayload {
  type?: string;
  actions?: Array<{ action_id: string; value?: string }>;
  user?: { id: string };
  trigger_id?: string;
  response_url?: string;
  channel?: { id?: string };
  /** Present on shortcut (`type: 'shortcut'`) + message-action (`message_action`) payloads. */
  callback_id?: string;
  /** Workspace context on shortcut / message-action payloads (the `T…` id). */
  team?: { id?: string };
  message?: { ts?: string; text?: string; thread_ts?: string };
  view?: {
    callback_id?: string;
    state?: {
      values?: Record<
        string,
        Record<string, { selected_option?: { value: string }; value?: string }>
      >;
    };
    private_metadata?: string;
  };
}

/**
 * A Slack button carries the target workflow id in its `value`, which any
 * client can forge (or read from a forwarded message). Gate every signal on
 * the same run-visibility predicate the dashboard uses.
 */
async function canSeeRun(
  fastify: FastifyInstance,
  user: { id: string; role: string },
  workflowId: string
): Promise<boolean> {
  // Slack routes authenticate by request signature rather than `requireAuth`,
  // so there is no `request.repoAccessGate` to inherit — the gate is resolved
  // here instead. Leaving it out would make every Slack button a way past a
  // check the dashboard applies, and these buttons signal workflows.
  const gate = (await resolveRepoAccessGateOrLastKnown()) ?? undefined;
  const run = await fastify.prisma.workflowRun.findFirst({
    select: { id: true },
    where: {
      workflowId,
      ...buildWorkflowRunVisibilityFilter({ role: user.role, sub: user.id }, gate),
    },
  });
  return run !== null;
}

export const slackRoutes: FastifyPluginAsync = async (fastify) => {
  // Slack delivers slash commands + interactive payloads as
  // application/x-www-form-urlencoded — register a scoped parser so the routes
  // below see `request.body` as an object even when this plugin is mounted
  // standalone (as the tests do). fastify-raw-body has already captured the
  // bytes for signature verification (`runFirst: true` in the plugin config).
  // In the full gateway, index.ts registers an app-level parser with the same
  // Record<string, string> shape, so this duplicate registration throws
  // FST_ERR_CTP_ALREADY_PRESENT — caught and ignored; the app-level parser
  // serves these routes.
  try {
    fastify.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          const params = new URLSearchParams(body as string);
          const out: Record<string, string> = {};
          for (const [k, v] of params) {
            out[k] = v;
          }
          done(null, out);
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );
  } catch {
    /* parser already registered at a parent scope */
  }

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
      // bearer credential.
      const state = fastify.auth.signOAuthState(user.sub, 'slack-link');

      const redirectUri = `${resolvePublicUrl()}/api/v1/auth/slack/callback`;
      // We link by Slack user id only; identity.basic is sufficient.
      const scopes = 'identity.basic';

      const url = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;

      return reply.redirect(url);
    }
  );

  // GET /api/v1/auth/slack/callback — Handle Slack OAuth callback
  fastify.get('/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };

    if (!code || !state) {
      return reply.status(400).send({
        error: { code: 'INVALID_CALLBACK', message: 'Missing code or state' },
      });
    }

    // Verify the single-purpose OAuth state token.
    let statePayload: { sub: string };
    try {
      statePayload = fastify.auth.verifyOAuthState(state, 'slack-link');
    } catch {
      return reply.status(400).send({
        error: { code: 'INVALID_STATE', message: 'Invalid state parameter' },
      });
    }

    const { clientId, clientSecret } = await resolveSlackConfig();
    if (!clientId || !clientSecret) {
      return reply.status(503).send({
        error: { code: 'SLACK_NOT_CONFIGURED', message: 'Slack OAuth credentials missing' },
      });
    }
    const redirectUri = `${resolvePublicUrl()}/api/v1/auth/slack/callback`;
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
      // Single-purpose, short-lived signed state (not a bearer credential).
      const state = fastify.auth.signOAuthState(user.sub, 'slack-install');
      const redirectUri = `${resolvePublicUrl()}/api/v1/auth/slack/install/callback`;
      const url = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${encodeURIComponent(SLACK_INSTALL_BOT_SCOPES)}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
      return reply.redirect(url);
    }
  );

  // GET /api/v1/auth/slack/install/callback — Complete the bot install: exchange
  // the code for the workspace bot token and persist it encrypted on the
  // workspace row. Redirects back to the admin integrations page on success.
  fastify.get('/install/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };
    if (!code || !state) {
      return reply.status(400).send({
        error: { code: 'INVALID_CALLBACK', message: 'Missing code or state' },
      });
    }
    let installerId: string;
    try {
      installerId = fastify.auth.verifyOAuthState(state, 'slack-install').sub;
    } catch {
      return reply.status(400).send({
        error: { code: 'INVALID_STATE', message: 'Invalid state parameter' },
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
    const redirectUri = `${resolvePublicUrl()}/api/v1/auth/slack/install/callback`;
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

    // Bounce back to the admin integrations page with a success flag.
    return reply.redirect(
      `${resolveWebUrl()}/admin/integrations?tab=slack&slack_installed=${slackTeamId}`
    );
  });

  // POST /api/v1/webhooks/slack — Handle Slack interactive webhooks
  fastify.post(
    '/interactive',
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      const { signingSecret } = await resolveSlackConfig();
      if (!signingSecret) {
        return reply.status(503).send({
          error: { code: 'SLACK_NOT_CONFIGURED', message: 'Slack signing secret not configured' },
        });
      }

      const timestamp = request.headers['x-slack-request-timestamp'] as string;
      const signature = request.headers['x-slack-signature'] as string;

      if (!timestamp || !signature) {
        return reply.status(401).send({
          error: { code: 'SLACK_AUTH_FAILED', message: 'Missing Slack signature headers' },
        });
      }

      const rawBody = (request as FastifyRequest & { rawBody?: string | Buffer }).rawBody;
      if (!rawBody) {
        return reply.status(400).send({
          error: { code: 'SLACK_AUTH_FAILED', message: 'Missing raw body' },
        });
      }

      if (!verifySlackSignature(rawBody.toString(), timestamp, signature, signingSecret)) {
        return reply.status(401).send({
          error: { code: 'SLACK_AUTH_FAILED', message: 'Invalid Slack signature' },
        });
      }

      // Parse the interactive payload
      const body = request.body as { payload?: string };
      const payload: SlackInteractivePayload = JSON.parse(body.payload ?? '{}');
      const slackUserId = payload.user?.id;

      if (!slackUserId) {
        return { data: { ignored: true } };
      }

      const actionId = payload.actions?.[0]?.action_id ?? '';
      const isHitlResolve = actionId === 'hitl_resolve' || actionId.startsWith('hitl_resolve:');
      const isRunShortcut =
        payload.type === 'shortcut' && payload.callback_id === 'auto_swe_run_shortcut';

      // Message shortcut ("Ask auto-swe about this"): start a channel-assistant
      // turn seeded with the message text, replying in its thread. Like an
      // @mention, it does NOT require the clicker's account to be linked, so it's
      // handled before the account-link gate below. Ack within Slack's 3s window,
      // then provision + start out-of-band (the worker posts the reply).
      if (payload.type === 'message_action' && payload.callback_id === 'auto_swe_ask_shortcut') {
        reply.send('');
        void handleAskMessageShortcut(fastify, payload).catch((err) => {
          request.log.error({ err }, 'slack message shortcut (ask) failed');
        });
        return reply;
      }

      // Resolve user by Slack ID
      const user = await fastify.prisma.user.findFirst({
        where: { slackId: slackUserId },
      });

      if (!user) {
        if (isHitlResolve) {
          // Button clicks come from arbitrary channel members — answer the
          // clicker with an ephemeral hint instead of a bare 403 (Slack shows
          // nothing useful for non-2xx interaction responses).
          await respondToInteraction(
            payload,
            ':lock: Link your Slack account in Settings first — then you can resolve steps from Slack.',
            { ephemeral: true }
          );
          return { data: { ignored: true, reason: 'slack_user_not_linked' } };
        }
        if (isRunShortcut && payload.trigger_id) {
          // A global shortcut has no channel/response_url, so an ephemeral hint
          // can't reach the clicker — open an info modal via views.open instead
          // of a bare 403 (which Slack renders as nothing).
          const botToken = await resolveSlackBotTokenForWorkspace(payload.team?.id ?? '');
          await openSlackView(
            { triggerId: payload.trigger_id, view: buildLinkAccountModalView() },
            botToken ?? undefined
          );
          return { data: { ignored: true, reason: 'slack_user_not_linked' } };
        }
        return reply.status(403).send({
          error: { code: 'USER_NOT_FOUND', message: 'No user linked to this Slack account' },
        });
      }

      // Global shortcut ("Run a workflow"): open the same run-picker modal as
      // `/auto-swe run`. Requires a linked user (the modal lists the templates +
      // repos they can access) — an unlinked clicker was already handled by the
      // account-link gate above.
      if (payload.type === 'shortcut' && payload.callback_id === 'auto_swe_run_shortcut') {
        if (!payload.trigger_id) {
          return { data: { ignored: true, reason: 'missing_trigger_id' } };
        }
        const built = await buildRunModalView(fastify, user, '', '');
        if (!built.ok) {
          return { data: { ignored: true, reason: built.error } };
        }
        const botToken = await resolveSlackBotTokenForWorkspace(payload.team?.id ?? '');
        const opened = await openSlackView(
          { triggerId: payload.trigger_id, view: built.view },
          botToken ?? undefined
        );
        if (!opened.ok) {
          return { data: { ignored: true, reason: opened.error ?? 'views_open_failed' } };
        }
        return reply.send('');
      }

      // View-submission: the workflow picker modal closing with "Run".
      if (
        payload.type === 'view_submission' &&
        payload.view?.callback_id === 'auto_swe_run_modal'
      ) {
        return handleRunModalSubmission(fastify, user, payload);
      }

      if (!actionId) {
        return { data: { ignored: true } };
      }

      // HITL resolve buttons posted by the worker's notifySlackHumanStep.
      // Shares the inbox route's resolve core (lib/hitlResolve.ts): same team
      // visibility, action validation, atomic guard, and signal rollback.
      if (isHitlResolve) {
        return handleHitlResolveAction(fastify, request, user, payload);
      }

      // Handle known actions
      if (actionId.startsWith('approve_')) {
        // Only LEAD or ADMIN can approve
        if (!hasRole(user.role, 'LEAD')) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Only LEAD or ADMIN can approve workflows' },
          });
        }

        const workflowId = payload.actions?.[0]?.value;
        if (!workflowId) {
          return reply.status(400).send({
            error: { code: 'INVALID_PAYLOAD', message: 'Missing workflow id in action value' },
          });
        }
        if (!(await canSeeRun(fastify, user, workflowId))) {
          return reply
            .status(404)
            .send({ error: { code: 'RUN_NOT_FOUND', message: 'Run not found' } });
        }
        await fastify.temporal.signalWorkflow(workflowId, 'humanMergeSignal', [true]);
        return { data: { action: 'approved', workflowId } };
      }

      if (actionId.startsWith('retry_ci_')) {
        const workflowId = payload.actions?.[0]?.value;
        if (!workflowId) {
          return reply.status(400).send({
            error: { code: 'INVALID_PAYLOAD', message: 'Missing workflow id in action value' },
          });
        }
        if (!(await canSeeRun(fastify, user, workflowId))) {
          return reply
            .status(404)
            .send({ error: { code: 'RUN_NOT_FOUND', message: 'Run not found' } });
        }
        // Signal CI failure to trigger the CI fix loop. The workflow will
        // re-provision a workspace, run the CI fix agent, and push a new commit.
        // This is intentionally "passed: false" — the user is requesting the
        // agent to fix CI, not to re-run the same CI pipeline.
        await fastify.temporal.signalWorkflow(workflowId, 'ciPipelineSignal', [
          { logsUrl: undefined, passed: false },
        ]);
        return { data: { action: 'ci_fix_requested', workflowId } };
      }

      return { data: { ignored: true, reason: 'Unknown action' } };
    }
  );

  // POST /api/v1/auth/slack/commands — Handle Slack slash commands
  // The slash command is `/auto-swe` (configured in the Slack app manifest). It
  // dispatches on `text` to subcommands:
  //   /auto-swe workflows list            → list visible workflow templates
  //   /auto-swe workflows show <name>     → show one template's spec
  //   /auto-swe run                       → open the work-request modal (workflow picker)
  // The slash-command handler must reply within 3s so we keep the handlers thin
  // (no Temporal start here — modal submit handles that).
  fastify.post(
    '/commands',
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      const { signingSecret } = await resolveSlackConfig();
      if (!signingSecret) {
        return reply.status(503).send({
          error: { code: 'SLACK_NOT_CONFIGURED', message: 'Slack signing secret not configured' },
        });
      }
      const timestamp = request.headers['x-slack-request-timestamp'] as string | undefined;
      const signature = request.headers['x-slack-signature'] as string | undefined;
      const rawBody = (request as FastifyRequest & { rawBody?: string | Buffer }).rawBody;
      if (
        !timestamp ||
        !signature ||
        !rawBody ||
        !verifySlackSignature(rawBody.toString(), timestamp, signature, signingSecret)
      ) {
        return reply.status(401).send({
          error: { code: 'SLACK_AUTH_FAILED', message: 'Invalid Slack signature' },
        });
      }

      // Slack sends slash commands as application/x-www-form-urlencoded
      const body = request.body as Record<string, string | undefined>;
      const slackUserId = body.user_id ?? '';
      const text = (body.text ?? '').trim();
      const triggerId = body.trigger_id ?? '';
      const channelId = body.channel_id ?? '';

      const user = slackUserId
        ? await fastify.prisma.user.findFirst({ where: { slackId: slackUserId } })
        : null;
      if (!user) {
        // Ephemeral reply — only visible to the invoking user
        return ephemeral(
          'Your Slack account is not linked to auto-swe. Visit /api/v1/auth/slack/connect to link it.'
        );
      }

      const [head, ...rest] = text.split(/\s+/).filter(Boolean);
      const sub = head ?? '';
      const arg = rest.join(' ').trim();

      try {
        if (sub === 'workflows' && (rest[0] ?? '') === 'list') {
          const tpls = await listVisibleTemplates(fastify, user);
          return ephemeral(formatTemplateList(tpls));
        }
        if (sub === 'workflows' && (rest[0] ?? '') === 'show') {
          const name = rest.slice(1).join(' ').trim();
          if (!name) {
            return ephemeral('Usage: `/auto-swe workflows show <name>`');
          }
          const tpl = await findTemplateByName(fastify, user, name);
          if (!tpl) {
            return ephemeral(`No workflow template named "${name}" is visible to you.`);
          }
          return ephemeral(formatTemplateShow(tpl));
        }
        if (sub === 'run') {
          if (!triggerId) {
            return ephemeral('Slack did not provide a trigger_id — please try again.');
          }
          const built = await buildRunModalView(fastify, user, channelId, arg);
          if (!built.ok) {
            return ephemeral(built.error);
          }
          // Per-workspace token (Full multi-workspace): the slash command carries
          // the invoking workspace's `team_id` — open the modal with that
          // workspace's bot token (singleton fallback inside the resolver).
          const slackBotToken = await resolveSlackBotTokenForWorkspace(body.team_id ?? '');
          const opened = await openSlackView(
            { triggerId, view: built.view },
            slackBotToken ?? undefined
          );
          if (!opened.ok) {
            return ephemeral(`Could not open modal: ${opened.error ?? 'unknown error'}`);
          }
          return reply.send(''); // empty 200 ack
        }
        if (sub === 'help' || sub === '' || sub === undefined) {
          return ephemeral(slashHelpText());
        }
        return ephemeral(`Unknown subcommand "${sub}".\n\n${slashHelpText()}`);
      } catch (err) {
        request.log.error({ err }, 'slack slash command failed');
        return ephemeral(
          `Command failed: ${err instanceof Error ? err.message : 'internal error'}`
        );
      }
    }
  );

  // POST /api/v1/auth/slack/events — Slack Events API callback (channel assistant).
  // Drives the conversational teammate: an @mention in a channel (or a DM)
  // starts a `ChannelAssistantWorkflow` that generates + posts the reply
  // in-thread (the worker owns the reply; the gateway only starts the workflow).
  //
  // Slack's 3-second rule: we ack 200 immediately for `event_callback`s and do
  // the channel auto-provision + workflow start asynchronously (self-contained
  // error handling so there are no unhandled rejections).
  fastify.post(
    '/events',
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as SlackEventCallback;

      // Verify the Slack signature FIRST — including the url_verification
      // handshake, which Slack signs. Authenticating every request (handshake
      // included) prevents an unauthenticated caller from echoing challenges or
      // probing the endpoint. The signing secret must be saved in the admin UI
      // before completing Slack's Events URL verification.
      const { signingSecret } = await resolveSlackConfig();
      if (!signingSecret) {
        return reply.status(503).send({
          error: { code: 'SLACK_NOT_CONFIGURED', message: 'Slack signing secret not configured' },
        });
      }

      const timestamp = request.headers['x-slack-request-timestamp'] as string | undefined;
      const signature = request.headers['x-slack-signature'] as string | undefined;
      const rawBody = (request as FastifyRequest & { rawBody?: string | Buffer }).rawBody;
      if (
        !timestamp ||
        !signature ||
        !rawBody ||
        !verifySlackSignature(rawBody.toString(), timestamp, signature, signingSecret)
      ) {
        return reply.status(401).send({
          error: { code: 'SLACK_AUTH_FAILED', message: 'Invalid Slack signature' },
        });
      }

      // URL-verification handshake (app setup) — echo the challenge once the
      // signature has passed.
      if (body.type === 'url_verification') {
        return reply.send({ challenge: body.challenge ?? '' });
      }

      if (body.type !== 'event_callback') {
        // Other top-level types (e.g. app_rate_limited) — ack and ignore.
        return reply.send({ ok: true });
      }

      // Slack redelivers events it thinks failed (no 2xx within 3s). We ack
      // every retry but skip processing so the workflow starts exactly once
      // (Phase 0 dedup — `x-slack-retry-num` is 1-based on the first retry).
      if (request.headers['x-slack-retry-num'] !== undefined) {
        return reply.send({ ok: true });
      }

      const event = body.event;
      // Ignore self-authored + system messages (bot replies, edits, joins, …).
      if (!event || event.bot_id || event.subtype) {
        return reply.send({ ok: true });
      }

      // App Home tab (Gap I — packaged Slack-app UX): when a user opens the app's
      // Home tab, publish the Home view (the assistant's "front door"). Ack first,
      // publish out-of-band. Only the `home` tab; `messages` tab is ignored.
      if (event.type === 'app_home_opened' && event.user && event.tab === 'home') {
        reply.send({ ok: true });
        const userId = event.user;
        // Per-workspace token: publish with the bot token of the workspace that
        // raised the event (singleton fallback inside the resolver).
        const homeTeamId = event.team ?? body.team_id ?? body.authorizations?.[0]?.team_id ?? '';
        void (async () => {
          const botToken = await resolveSlackBotTokenForWorkspace(homeTeamId);
          const result = await publishAppHome(userId, botToken ?? undefined);
          if (!result.ok) {
            request.log.warn({ err: result.error, userId }, 'slack app_home publish failed');
          }
        })().catch((err) => {
          request.log.error({ err }, 'slack app_home handler failed');
        });
        return reply;
      }

      const isMention = event.type === 'app_mention';
      const isDm = event.type === 'message' && event.channel_type === 'im';
      // A thread reply is a message whose thread root (`thread_ts`) differs from
      // its own `ts`. We additionally process plain (non-mention) channel
      // `message` events when they're thread replies — ONLY to attempt steering
      // an in-flight task run bound to that thread. If no run matches, they're
      // ignored (we never start a turn off arbitrary channel chatter).
      const isThreadReply = !!event.thread_ts && event.thread_ts !== event.ts;
      const isPlainChannelMessage =
        event.type === 'message' && event.channel_type !== 'im' && !isMention;
      if (!isMention && !isDm && !(isPlainChannelMessage && isThreadReply)) {
        // Non-thread plain channel chatter (ambient) is a later phase — never act
        // on it here, so the bot doesn't become a firehose responder.
        return reply.send({ ok: true });
      }

      // Ack within Slack's 3s window, THEN process out-of-band. The reply is
      // posted by the worker, so the HTTP response carries no payload.
      reply.send({ ok: true });

      void processChannelEvent(fastify, body, event).catch((err) => {
        request.log.error({ err }, 'slack channel-assistant event processing failed');
      });
      return reply;
    }
  );
};

// ── Slack Events API (channel assistant) ────────────────────────────────────

interface SlackEventInner {
  type?: string;
  /** Present on `message.im` events; distinguishes DMs from channel messages. */
  channel_type?: string;
  /** Slack user id (`U…`) of the author. Absent on some system messages. */
  user?: string;
  /** Bot id when authored by a bot/app — used to ignore the bot's own posts. */
  bot_id?: string;
  /** Message subtype (edits, joins, …). Ignored to avoid system-message noise. */
  subtype?: string;
  /** Channel id (`C…` / `D…`). */
  channel?: string;
  /** Message text (with `<@U…>` mention tokens for app_mention). */
  text?: string;
  /** This message's timestamp. */
  ts?: string;
  /** Set when the message is already inside a thread. */
  thread_ts?: string;
  /** Workspace/team id on the event itself (not always present). */
  team?: string;
  /** App Home tab id on `app_home_opened` events (`home` | `messages`). */
  tab?: string;
}

interface SlackEventCallback {
  type?: string;
  /** url_verification handshake. */
  challenge?: string;
  /** Top-level workspace id for event_callback envelopes. */
  team_id?: string;
  event?: SlackEventInner;
  authorizations?: Array<{ team_id?: string }>;
}

/** Strip Slack mention tokens (`<@U…>`, `<@U…|name>`) and collapse whitespace. */
function stripMentions(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Auto-provision the channel and start the assistant workflow. Runs out-of-band
 * after the 200 ack, so it owns its errors (logged by the caller's `.catch`).
 */
async function processChannelEvent(
  fastify: FastifyInstance,
  body: SlackEventCallback,
  event: SlackEventInner
): Promise<void> {
  const slackChannelId = event.channel;
  const eventTs = event.ts;
  if (!slackChannelId || !eventTs) {
    return;
  }

  const slackTeamId = event.team ?? body.team_id ?? body.authorizations?.[0]?.team_id;
  if (!slackTeamId) {
    fastify.log.warn({ event }, 'slack event missing workspace id — cannot provision channel');
    return;
  }

  const userText = stripMentions(event.text ?? '');
  const threadTs = event.thread_ts ?? eventTs;

  // Gap G: Slack tags private channels with `channel_type: 'group'` (public is
  // 'channel', DMs 'im'). Pass it as a best-effort default for a freshly
  // provisioned channel's `isPrivate` flag; admins can override afterwards.
  const channelRow = await provisionChannel(fastify, slackTeamId, slackChannelId, {
    isPrivate: event.channel_type === 'group',
  });
  if (!channelRow) {
    return;
  }

  // Signal-steering (Phase C): a reply inside a thread that already has an
  // in-flight task run STEERS that run instead of starting a fresh turn. A reply
  // is identified by `thread_ts` differing from this message's own `ts`. We try
  // the `steer` signal first — and only when it succeeds do we treat the event
  // as handled. A WorkflowNotFoundError (no active task run in this thread) is
  // benign: we fall through to normal handling below (a fresh mention → a turn;
  // a plain non-mention reply → ignored). Steering takes precedence over
  // launching a new turn in the same thread, so a thread reply that is ALSO an
  // app_mention still steers an active run.
  const isThreadReply = !!event.thread_ts && event.thread_ts !== eventTs;
  if (isThreadReply && event.thread_ts) {
    const steered = await trySteerThreadTask(
      fastify,
      channelRow.id,
      event.thread_ts,
      slackChannelId,
      userText
    );
    if (steered) {
      return;
    }
  }

  const isMention = event.type === 'app_mention';
  const isDm = event.type === 'message' && event.channel_type === 'im';
  // No active task run to steer. Plain (non-mention, non-DM) channel thread
  // replies normally do NOT start a turn — they only exist to attempt a steer.
  // EXCEPTION (Gap H — persistent live session): when the channel opts in
  // (`followupSessionEnabled`) and the assistant was recently active in THIS
  // thread, a plain follow-up reply continues the conversation without a
  // re-@mention. Otherwise drop it so arbitrary channel chatter never spawns a
  // workflow.
  // Gap H: true only for a re-mention-free continuation (a plain thread reply in
  // a live session). Drives the SKIP-aware intent gate in the turn so the
  // assistant stays out of human-to-human chatter.
  let isFollowup = false;
  if (!isMention && !isDm) {
    const continues =
      isThreadReply &&
      !!event.thread_ts &&
      channelRow.followupSessionEnabled &&
      (await isLiveThreadSession(fastify, channelRow.id, event.thread_ts));
    if (!continues) {
      return;
    }
    isFollowup = true;
    // Fall through to start a continuation turn (same path as a mention).
  }

  const input: ChannelAssistantTurnInput = {
    channelId: channelRow.id,
    followup: isFollowup,
    orgId: channelRow.orgId,
    slackChannelId,
    teamId: channelRow.teamId,
    threadTs,
    userSlackId: event.user ?? '',
    userText,
  };

  const started = await startChannelTurn(fastify, `chan-${channelRow.id}-${eventTs}`, input);
  if (!started) {
    fastify.log.info(
      { channelId: channelRow.id, eventTs },
      'channel-assistant workflow already started for this event — skipping redelivery'
    );
  }
}

/**
 * Start a channel-assistant turn, swallowing the REJECT_DUPLICATE rejection.
 * Channel-turn workflow ids are deterministic (`chan-<id>-<ts>` for @mentions,
 * `chan-<id>-ask-<ts>` for the message shortcut) and started with
 * REJECT_DUPLICATE, so a Slack redelivery of the same event — or a double
 * shortcut click on the same message — is rejected here. That's the desired
 * idempotent behaviour: returns `true` when a fresh run started, `false` when it
 * was a duplicate (caller decides whether to log). Other errors propagate.
 */
async function startChannelTurn(
  fastify: FastifyInstance,
  workflowId: string,
  input: ChannelAssistantTurnInput
): Promise<boolean> {
  try {
    await fastify.temporal.startChannelAssistant(workflowId, input);
    return true;
  } catch (err) {
    if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
      return false;
    }
    throw err;
  }
}

/** Gap H: how long after the assistant's last reply a plain follow-up (no
 *  re-@mention) still continues the conversation. Self-limiting so the bot never
 *  re-engages stale threads. */
const SESSION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Persistent live session (Gap H): is the assistant "live" in this thread right
 * now? True when a `ChannelThreadSession` exists for `(channelId, threadTs)` and
 * its `lastAssistantAt` is within {@link SESSION_WINDOW_MS}. Best-effort: any DB
 * error resolves to `false` (fail closed — never start an unexpected turn).
 */
async function isLiveThreadSession(
  fastify: FastifyInstance,
  channelId: string,
  threadTs: string
): Promise<boolean> {
  try {
    const session = await fastify.prisma.channelThreadSession.findUnique({
      select: { lastAssistantAt: true },
      where: { channelId_threadTs: { channelId, threadTs } },
    });
    if (!session) {
      return false;
    }
    return Date.now() - session.lastAssistantAt.getTime() < SESSION_WINDOW_MS;
  } catch (err) {
    fastify.log.warn({ channelId, err, threadTs }, 'isLiveThreadSession lookup failed');
    return false;
  }
}

/**
 * Attempt to steer an in-flight channel task run bound to this thread. The task
 * run's Temporal workflowId is deterministic — `channelTaskWorkflowId(channelId,
 * threadTs)` — so we reconstruct it without a DB lookup and deliver the new
 * guidance via the `steer` signal.
 *
 * Returns `true` only when the signal was delivered (an active run exists and
 * was steered). A `WorkflowNotFoundError` — no run, or the run already
 * closed/terminated — means "nothing to steer here"; we return `false` so the
 * caller falls through to normal handling. On a successful steer we post a tiny
 * best-effort in-thread ack (never fails the steer).
 */
async function trySteerThreadTask(
  fastify: FastifyInstance,
  channelId: string,
  threadTs: string,
  slackChannelId: string,
  userText: string
): Promise<boolean> {
  const workflowId = channelTaskWorkflowId(channelId, threadTs);
  try {
    await fastify.temporal.signalWorkflow(workflowId, CHANNEL_TASK_STEER_SIGNAL, [userText]);
  } catch (err) {
    // No active task run in this thread (or it already closed) — fall through.
    if (isTerminalSignalError(err)) {
      return false;
    }
    throw err;
  }

  // Best-effort in-thread ack so the human sees the steer landed. Never let
  // chatter failures undo the (already-delivered) steer.
  try {
    const botToken = await resolveSlackBotTokenForSlackChannel(slackChannelId);
    await postSlackMessage(
      {
        channel: slackChannelId,
        text: ':writing_hand: noted — steering the task.',
        threadTs,
      },
      botToken ?? undefined
    );
  } catch (err) {
    fastify.log.warn(
      { channelId, err, threadTs },
      'steer ack post failed (steer already delivered)'
    );
  }
  return true;
}

/**
 * Message shortcut handler ("Ask auto-swe about this"). Provisions the channel
 * (like an @mention) and starts a channel-assistant turn seeded with the message
 * text, threaded under that message. Runs out-of-band after the interactivity ack;
 * owns its errors (logged by the caller's `.catch`).
 */
async function handleAskMessageShortcut(
  fastify: FastifyInstance,
  payload: SlackInteractivePayload
): Promise<void> {
  const slackChannelId = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const slackTeamId = payload.team?.id;
  if (!slackChannelId || !messageTs || !slackTeamId) {
    fastify.log.warn(
      { callbackId: payload.callback_id },
      'ask message shortcut missing channel/message/team'
    );
    return;
  }

  // File/image-only messages carry no text — a turn seeded with an empty prompt
  // is useless, so skip rather than spawn a no-op workflow.
  const userText = stripMentions(payload.message?.text ?? '');
  if (!userText) {
    fastify.log.info(
      { messageTs, slackChannelId },
      'ask message shortcut on empty message — skipping'
    );
    return;
  }

  // Gap G: Slack private-channel ids are prefixed `G` (public `C`). Pass it as a
  // best-effort default for a freshly provisioned channel's `isPrivate` flag —
  // the shortcut payload lacks the `channel_type` the events path uses.
  const channelRow = await provisionChannel(fastify, slackTeamId, slackChannelId, {
    isPrivate: slackChannelId.startsWith('G'),
  });
  if (!channelRow) {
    return;
  }

  // Reply in the message's thread (or thread under it when it's a top-level message).
  const threadTs = payload.message?.thread_ts ?? messageTs;
  const input: ChannelAssistantTurnInput = {
    channelId: channelRow.id,
    followup: false,
    orgId: channelRow.orgId,
    slackChannelId,
    teamId: channelRow.teamId,
    threadTs,
    userSlackId: payload.user?.id ?? '',
    userText,
  };

  // Namespace with `-ask-` so the shortcut's per-message workflowId never
  // collides with the @mention path's `chan-<id>-<ts>` for the same message
  // ts — a collision would be swallowed as a duplicate and the click would go
  // unanswered. `startChannelTurn` keeps the double-click idempotent.
  await startChannelTurn(fastify, `chan-${channelRow.id}-ask-${messageTs}`, input);
}

/**
 * Resolve (or create) the `SlackWorkspace` + `SlackChannel` rows for an incoming
 * event. New workspaces/channels are mapped to the default team (and its org)
 * resolved from the workflow defaults. Returns null when the default team is
 * missing (deployment not seeded) — the caller logs and drops the turn.
 */
async function provisionChannel(
  fastify: FastifyInstance,
  slackTeamId: string,
  slackChannelId: string,
  opts: { isPrivate?: boolean } = {}
): Promise<{
  id: string;
  teamId: string;
  orgId: string;
  followupSessionEnabled: boolean;
} | null> {
  // The overwhelming majority of events are for a channel that already exists.
  // Answer those from one joined read: everything below — the workflow defaults,
  // the team lookup, the workspace upsert (a write) and the Slack call — is only
  // needed to create a channel for the first time. `findFirst` is not a guarded
  // operation, and the query names the channel outright.
  const CHANNEL_FIELDS = {
    followupSessionEnabled: true,
    id: true,
    orgId: true,
    teamId: true,
  } as const;
  const existing = await fastify.prisma.slackChannel.findFirst({
    select: CHANNEL_FIELDS,
    where: { slackChannelId, workspace: { slackTeamId } },
  });
  if (existing) {
    return existing;
  }

  const { defaultTeamSlug } = await resolveWorkflowDefaults();
  const defaultTeam = await fastify.prisma.team.findUnique({ where: { slug: defaultTeamSlug } });
  if (!defaultTeam) {
    fastify.log.error(
      { defaultTeamSlug },
      'default team not found — cannot auto-provision Slack channel (run `yarn db:seed`)'
    );
    return null;
  }

  // Prisma `upsert` is find-then-create (not atomic), so two concurrent
  // first-mentions can both reach the create branch and one loses the race with
  // a P2002 on the unique constraint. Catch it and re-fetch the now-existing row
  // so a redelivered/concurrent first turn isn't dropped.
  const workspace = await fastify.prisma.slackWorkspace
    .upsert({
      create: { orgId: defaultTeam.orgId, slackTeamId },
      update: {},
      where: { slackTeamId },
    })
    .catch(async (err) => {
      if (isUniqueConstraintError(err)) {
        return fastify.prisma.slackWorkspace.findUnique({ where: { slackTeamId } });
      }
      throw err;
    });
  if (!workspace) {
    fastify.log.error({ slackTeamId }, 'failed to resolve Slack workspace after race');
    return null;
  }

  const channelWhere = {
    workspaceId_slackChannelId: { slackChannelId, workspaceId: workspace.id },
  };

  // Ask Slack rather than trusting the caller's heuristic. This flag decides
  // whether the channel's memory can ever be read by another channel, and it is
  // written on create only — so neither source can undo a later admin override,
  // and the round-trip is paid once per channel rather than once per mention.
  const token = (await resolveSlackBotTokenForWorkspace(slackTeamId)) ?? undefined;
  const authoritative = await fetchSlackChannelIsPrivate(slackChannelId, token);
  const isPrivate = authoritative ?? opts.isPrivate ?? false;
  if (authoritative === null && token) {
    // Falling back to the payload heuristic is the old behaviour, but silently:
    // a missing `groups:read` scope or a flaky call would mark a private channel
    // public *permanently*, since the flag is written on create only.
    fastify.log.warn(
      { isPrivate, slackChannelId },
      'could not read is_private from Slack — provisioning the channel from the payload heuristic'
    );
  }

  // A plain create, since the existence check above already ran. Two concurrent
  // first-mentions can still both get here; the loser re-reads.
  return await fastify.prisma.slackChannel
    .create({
      data: {
        isPrivate,
        orgId: workspace.orgId,
        slackChannelId,
        teamId: defaultTeam.id,
        workspaceId: workspace.id,
      },
      select: CHANNEL_FIELDS,
    })
    .catch(async (err) => {
      if (isUniqueConstraintError(err)) {
        return fastify.prisma.slackChannel.findUnique({
          select: CHANNEL_FIELDS,
          where: channelWhere,
        });
      }
      throw err;
    });
}

// ── HITL resolve button (block_actions, action_id `hitl_resolve[:…]`) ───────

interface HitlButtonValue {
  stepId?: string;
  action?: string;
  value?: unknown;
}

/**
 * Resolve a pending human step from a Slack Block Kit button. The button
 * `value` carries JSON `{stepId, action, value?}` written by the worker's
 * `notifySlackHumanStep`. Authorization and resolve semantics are exactly the
 * inbox route's — both call `resolveHitlStep`.
 *
 * Always acks with HTTP 200 (Slack treats non-2xx as a delivery failure and
 * shows a generic warning); the human-readable outcome is delivered as a
 * thread reply / ephemeral message instead.
 */
async function handleHitlResolveAction(
  fastify: FastifyInstance,
  request: FastifyRequest,
  user: { id: string; role: string },
  payload: SlackInteractivePayload
): Promise<unknown> {
  let parsed: HitlButtonValue = {};
  try {
    parsed = JSON.parse(payload.actions?.[0]?.value ?? '{}') as HitlButtonValue;
  } catch {
    /* malformed JSON — handled below */
  }
  if (typeof parsed.stepId !== 'string' || !parsed.stepId || typeof parsed.action !== 'string') {
    await respondToInteraction(
      payload,
      ':warning: This button is malformed — please resolve the step from the inbox instead.',
      { ephemeral: true }
    );
    return { data: { action: 'hitl_resolve', ignored: true, reason: 'malformed_value' } };
  }

  const result = await resolveHitlStep(
    {
      // Slack authenticates by request signature, not `requireAuth`, so there
      // is no `request.repoAccessGate` to inherit — resolve it here or the
      // button becomes the way past a check the dashboard applies.
      gate: (await resolveRepoAccessGateOrLastKnown()) ?? undefined,
      log: request.log,
      prisma: fastify.prisma,
      temporal: fastify.temporal,
    },
    parsed.stepId,
    parsed.action,
    parsed.value,
    { role: user.role, sub: user.id }
  );

  if (result.ok) {
    const who = payload.user?.id ? `<@${payload.user.id}>` : 'someone';
    let text: string;
    if (result.status === 'PENDING') {
      text = `:hourglass: *${result.title}* — ${who} recorded \`${parsed.action}\` (${result.currentApprovers}/${result.requiredApprovers}). ${result.approvalsRemaining} more approval${result.approvalsRemaining === 1 ? '' : 's'} needed.`;
    } else if (result.signalSent) {
      text = `:white_check_mark: *${result.title}* — resolved with \`${parsed.action}\` by ${who} (${result.currentApprovers}/${result.requiredApprovers}).`;
    } else {
      text = `:white_check_mark: *${result.title}* — recorded as \`${parsed.action}\` by ${who} (${result.currentApprovers}/${result.requiredApprovers}), but the workflow run had already finished, so nothing was signalled.`;
    }
    await respondToInteraction(payload, text, { ephemeral: result.status === 'PENDING' });
    return {
      data: {
        action: 'hitl_resolve',
        approvalsRemaining: result.approvalsRemaining,
        currentApprovers: result.currentApprovers,
        ok: true,
        requiredApprovers: result.requiredApprovers,
        signalSent: result.signalSent,
        status: result.status,
        stepId: result.stepId,
      },
    };
  }

  await respondToInteraction(payload, hitlErrorText(result.code, result.message), {
    ephemeral: true,
  });
  return { data: { action: 'hitl_resolve', code: result.code, ok: false } };
}

function hitlErrorText(code: HitlResolveErrorCode, message: string): string {
  switch (code) {
    case 'ALREADY_RESOLVED':
      return ':information_source: This step has already been resolved — nothing left to do.';
    case 'NOT_FOUND':
      return ':warning: This step no longer exists or is not visible to you.';
    case 'RUN_NOT_RUNNING':
      return ':warning: The workflow run is no longer running.';
    case 'SIGNAL_FAILED':
      return ':warning: Could not deliver your response to the workflow — please try the button again.';
    default:
      return `:warning: ${message}`;
  }
}

/**
 * Best-effort reply to a Slack interaction. Success confirmations annotate the
 * original message as a thread reply (chat.postMessage — what lib/slack.ts
 * already supports); errors and the unlinked-account hint go to `response_url`
 * as an ephemeral message visible only to the clicker. Never replaces the
 * original message (`replace_original: false`) so the audit trail stays
 * intact. All failures are swallowed — Slack chatter must never fail the ack.
 */
async function respondToInteraction(
  payload: SlackInteractivePayload,
  text: string,
  opts: { ephemeral: boolean }
): Promise<void> {
  try {
    if (!opts.ephemeral && payload.channel?.id && payload.message?.ts) {
      const botToken = await resolveSlackBotTokenForSlackChannel(payload.channel.id);
      const ts = await postSlackMessage(
        { channel: payload.channel.id, text, threadTs: payload.message.ts },
        botToken ?? undefined
      );
      if (ts) {
        return;
      }
      // fall through to response_url if the thread reply failed
    }
    if (payload.response_url) {
      await fetch(payload.response_url, {
        body: JSON.stringify({
          replace_original: false,
          response_type: opts.ephemeral ? 'ephemeral' : 'in_channel',
          text,
        }),
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        method: 'POST',
      });
    }
  } catch {
    /* best-effort */
  }
}

// ── Slash-command helpers ───────────────────────────────────────────────────

function ephemeral(text: string): { response_type: 'ephemeral'; text: string } {
  return { response_type: 'ephemeral', text };
}

function slashHelpText(): string {
  return [
    '*auto-swe slash commands*',
    '• `/auto-swe workflows list` — list workflow templates visible to you',
    '• `/auto-swe workflows show <name>` — show one template (active version)',
    '• `/auto-swe run [description]` — open a work-request modal (workflow picker)',
    '• `/auto-swe help` — this message',
  ].join('\n');
}

interface SimpleTemplateRow {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  activeVersion: number | null;
  team: { id: string; slug: string; name: string } | null;
}

async function listVisibleTemplates(
  fastify: FastifyInstance,
  user: { id: string; role: string }
): Promise<SimpleTemplateRow[]> {
  const where =
    user.role === 'ADMIN'
      ? {}
      : {
          OR: [{ teamId: null }, { team: memberTeams({ sub: user.id }) }],
        };
  // `where` is `{}` for a platform admin — the deliberate cross-tenant branch.
  const rows = await asPlatformAdmin(
    user,
    "admin lists every team's templates",
    ['WorkflowTemplate'],
    () =>
      fastify.prisma.workflowTemplate.findMany({
        include: { team: { select: { id: true, name: true, slug: true } } },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        where,
      })
  );
  return rows.map((r) => ({
    activeVersion: r.activeVersion,
    description: r.description,
    id: r.id,
    isDefault: r.isDefault,
    name: r.name,
    team: r.team ? { id: r.team.id, name: r.team.name, slug: r.team.slug } : null,
  }));
}

async function findTemplateByName(
  fastify: FastifyInstance,
  user: { id: string; role: string },
  name: string
): Promise<
  | (SimpleTemplateRow & {
      spec: unknown | null;
      activeVersionRow: { version: number } | null;
    })
  | null
> {
  const tpls = await listVisibleTemplates(fastify, user);
  const tpl = tpls.find((t) => t.name === name);
  if (!tpl) {
    return null;
  }
  const v = tpl.activeVersion
    ? await fastify.prisma.workflowTemplateVersion.findUnique({
        where: { templateId_version: { templateId: tpl.id, version: tpl.activeVersion } },
      })
    : null;
  return {
    ...tpl,
    activeVersionRow: v ? { version: v.version } : null,
    spec: v ? v.spec : null,
  };
}

function formatTemplateList(rows: SimpleTemplateRow[]): string {
  if (rows.length === 0) {
    return 'No workflow templates visible to you.';
  }
  const lines = rows.map((r) => {
    const teamLabel = r.team ? r.team.slug : 'global';
    const defaultLabel = r.isDefault ? ' *(default)*' : '';
    const versionLabel = r.activeVersion ? ` v${r.activeVersion}` : ' (no active version)';
    return `• \`${r.name}\` — ${teamLabel}${versionLabel}${defaultLabel}`;
  });
  return ['*Workflow templates*', ...lines].join('\n');
}

function formatTemplateShow(
  tpl: SimpleTemplateRow & { spec: unknown | null; activeVersionRow: { version: number } | null }
): string {
  const teamLabel = tpl.team ? tpl.team.slug : 'global';
  const versionLabel = tpl.activeVersionRow
    ? `v${tpl.activeVersionRow.version}`
    : 'no active version';
  const header = `*${tpl.name}* — ${teamLabel} (${versionLabel})${tpl.isDefault ? ' — default' : ''}`;
  const desc = tpl.description ? `\n${tpl.description}` : '';
  if (!tpl.spec) {
    return `${header}${desc}`;
  }
  // Truncate to fit within Slack's 3000-char text limit for an ephemeral message.
  const json = JSON.stringify(tpl.spec, null, 2);
  const max = 2600;
  const trimmed = json.length > max ? `${json.slice(0, max)}\n…[truncated]` : json;
  return `${header}${desc}\n\`\`\`${trimmed}\`\`\``;
}

// ── Modal: work-request picker ──────────────────────────────────────────────

interface RunModalMetadata {
  channelId: string;
  initialDescription: string;
}

/**
 * A minimal info modal shown when an unlinked Slack user triggers the global
 * "Run a workflow" shortcut. Unlike a slash command or message action, a global
 * shortcut carries no channel/response_url, so an ephemeral hint can't reach the
 * clicker — this modal is the only surface available via the `trigger_id`.
 */
function buildLinkAccountModalView(): unknown {
  return {
    blocks: [
      {
        text: {
          text: 'Link your Slack account in *Settings → Slack* first, then trigger this shortcut again to pick a workflow to run.',
          type: 'mrkdwn',
        },
        type: 'section',
      },
    ],
    close: { text: 'Close', type: 'plain_text' },
    title: { text: 'auto-swe', type: 'plain_text' },
    type: 'modal',
  };
}

async function buildRunModalView(
  fastify: FastifyInstance,
  user: { id: string; role: string },
  channelId: string,
  initialDescription: string
): Promise<{ ok: true; view: unknown } | { ok: false; error: string }> {
  const tpls = await listVisibleTemplates(fastify, user);
  // A listing, so the decision belongs in the query. It used to load every
  // active repository and filter on selected membership rows, which offered a
  // picker containing repositories the user had lost GitHub access to — the
  // names alone are a leak, and picking one only failed at submit.
  const gate = (await resolveRepoAccessGateOrLastKnown()) ?? undefined;
  const where: Prisma.ConnectionWhereInput = {
    isActive: true,
    // Only git_repo connections are valid run targets; exclude non-git types (e.g. mcp).
    type: 'git_repo',
    ...(user.role !== 'ADMIN' && reachableConnections({ sub: user.id }, gate)),
  };
  const accessibleRepos = await asPlatformAdmin(
    user,
    "admin picks from every team's repos",
    ['Connection'],
    () =>
      fastify.prisma.connection.findMany({
        select: { id: true, organizationName: true, repoName: true },
        where,
      })
  );
  // The submission handler binds the repo via `selected_option.value` on a
  // `static_select` element — rendering a free-text fallback would silently
  // skip submission validation, so we short-circuit when there's nothing to
  // pick. Caller surfaces this as an ephemeral message.
  if (accessibleRepos.length === 0) {
    return {
      // Two causes, and telling someone to ask an admin is wrong for the
      // second: they may not be on a team, or the GitHub permission gate may be
      // enforcing before the sweep has recorded any answers for them, in which
      // case being added to a team changes nothing.
      error:
        gate?.mode === 'enforce'
          ? 'No repositories available. Either you are not on a team that owns one, or your GitHub access has not been confirmed yet — it is checked periodically, so try again shortly.'
          : 'You do not have access to any active repositories. Ask a team admin to add you.',
      ok: false,
    };
  }

  const repoOptions = accessibleRepos.slice(0, 100).map((r) => ({
    text: { text: `${r.organizationName}/${r.repoName}`, type: 'plain_text' as const },
    value: r.id,
  }));
  const tplOptions = [
    { text: { text: '(team default)', type: 'plain_text' as const }, value: '' },
    ...tpls.slice(0, 100).map((t) => ({
      text: {
        text: `${t.name}${t.isDefault ? ' (default)' : ''}`,
        type: 'plain_text' as const,
      },
      value: t.id,
    })),
  ];

  const metadata: RunModalMetadata = { channelId, initialDescription };

  const view = {
    blocks: [
      {
        block_id: 'ticket_block',
        element: {
          action_id: 'ticket_input',
          placeholder: { text: 'e.g. JIRA-1234', type: 'plain_text' },
          type: 'plain_text_input',
        },
        label: { text: 'Ticket ID', type: 'plain_text' },
        type: 'input',
      },
      {
        block_id: 'description_block',
        element: {
          action_id: 'description_input',
          ...(initialDescription ? { initial_value: initialDescription } : {}),
          multiline: true,
          placeholder: { text: 'What should the agent build?', type: 'plain_text' },
          type: 'plain_text_input',
        },
        label: { text: 'Description', type: 'plain_text' },
        type: 'input',
      },
      {
        block_id: 'repo_block',
        element: {
          action_id: 'repo_select',
          options: repoOptions,
          placeholder: { text: 'Select a repository', type: 'plain_text' },
          type: 'static_select',
        },
        label: { text: 'Repository', type: 'plain_text' },
        type: 'input',
      },
      {
        block_id: 'template_block',
        element: {
          action_id: 'template_select',
          initial_option: tplOptions[0],
          options: tplOptions,
          type: 'static_select',
        },
        label: { text: 'Workflow', type: 'plain_text' },
        optional: true,
        type: 'input',
      },
    ],
    callback_id: 'auto_swe_run_modal',
    close: { text: 'Cancel', type: 'plain_text' },
    private_metadata: JSON.stringify(metadata),
    submit: { text: 'Run', type: 'plain_text' },
    title: { text: 'Run a workflow', type: 'plain_text' },
    type: 'modal',
  };
  return { ok: true, view };
}

async function handleRunModalSubmission(
  fastify: FastifyInstance,
  user: { id: string; role: string },
  payload: SlackInteractivePayload
): Promise<unknown> {
  const values = payload.view?.state?.values ?? {};
  const ticket = (values.ticket_block?.ticket_input?.value ?? '').trim();
  const description = (values.description_block?.description_input?.value ?? '').trim();
  const repoId = values.repo_block?.repo_select?.selected_option?.value ?? '';
  const templateId = values.template_block?.template_select?.selected_option?.value ?? '';

  const errors: Record<string, string> = {};
  if (!ticket) {
    errors.ticket_block = 'Ticket ID is required';
  }
  if (!description) {
    errors.description_block = 'Description is required';
  }
  if (!repoId) {
    errors.repo_block = 'Repository is required';
  }
  if (Object.keys(errors).length > 0) {
    return { errors, response_action: 'errors' };
  }

  let metadata: RunModalMetadata = { channelId: '', initialDescription: '' };
  try {
    metadata = JSON.parse(payload.view?.private_metadata ?? '{}') as RunModalMetadata;
  } catch {
    /* keep defaults */
  }

  const repo = await fastify.prisma.connection.findUnique({
    include: {
      installation: { select: { installationId: true, isActive: true } },
      team: { select: { memberships: { where: { userId: user.id } } } },
    },
    where: { id: repoId },
  });
  if (!repo?.isActive) {
    return {
      errors: { repo_block: 'Repository not found or inactive' },
      response_action: 'errors',
    };
  }
  if (!isGitRepoConnection(repo)) {
    return {
      errors: { repo_block: 'Selected connection is not a git repository' },
      response_action: 'errors',
    };
  }

  // Team membership and GitHub permission in one decision, the same one the
  // dashboard's submit takes. Slack routes authenticate by request signature
  // rather than `requireAuth`, so the gate is resolved here.
  const decision = await decideRepoAccess(
    fastify.prisma,
    { role: user.role, sub: user.id },
    repo,
    (await resolveRepoAccessGateOrLastKnown()) ?? { mode: 'off', staleAfterHours: 0 }
  );
  if (!decision.allowed) {
    return {
      errors: { repo_block: REPO_ACCESS_REFUSAL_MESSAGE[decision.reason] },
      response_action: 'errors',
    };
  }

  // Resolve workflow template — explicit choice wins, else default resolver.
  let resolvedTemplate: { templateId: string; version: number } | null = null;
  if (templateId) {
    // Same visibility rule as the picker that offered the option (and as
    // POST /workflow-templates/:id/runs): a tampered client cannot launch a
    // template the user cannot see or one that is not active.
    const tpl = await fastify.prisma.workflowTemplate.findFirst({
      where: {
        id: templateId,
        status: 'ACTIVE',
        ...(user.role === 'ADMIN'
          ? {}
          : { OR: [{ teamId: null }, { team: memberTeams({ sub: user.id }) }] }),
      },
    });
    if (!tpl?.activeVersion) {
      return {
        errors: { template_block: 'Selected workflow has no active version' },
        response_action: 'errors',
      };
    }
    resolvedTemplate = { templateId: tpl.id, version: tpl.activeVersion };
  } else {
    const def = await resolveDefaultTemplate(fastify.prisma, repo.teamId, ticket);
    if (!def) {
      return {
        errors: { template_block: 'No default workflow template configured for this team' },
        response_action: 'errors',
      };
    }
    resolvedTemplate = { templateId: def.templateId, version: def.version };
  }

  const temporalWorkflowId = generateWorkflowId(ticket, repo.organizationName, repo.repoName);
  const { branchPrefix: slackBranchPrefix } = await resolveWorkflowDefaults();
  const branch = generateBranchName(ticket, slackBranchPrefix);
  const workRequestId = crypto.randomUUID();
  const repoWorkRequest: RepoWorkRequest = {
    budgetTier: 'STANDARD',
    description,
    externalTicketId: ticket,
    repoId: repo.id,
    requestPayload: JSON.stringify({ description, externalTicketId: ticket, source: 'slack' }),
    workRequestId,
  };

  // Ledger rows first, workflow second, rolled back if the start fails —
  // see `launchTrackedWorkflow`. The workflow ID is deterministic per
  // (org, repo, ticket), so the unique index is the real dedup gate here and a
  // double-submitted modal loses the race rather than starting a second run.
  const launch = await launchTrackedWorkflow(
    fastify.prisma,
    {
      activeWorkflow: {
        assignedBranch: branch,
        budgetTier: 'STANDARD',
        currentStatus: 'IMPLEMENTING',
        repoId: repo.id,
        temporalWorkflowId,
        workRequestId,
      },
      runInput: {
        description,
        externalTicketId: ticket,
        id: workRequestId,
        requestPayload: JSON.stringify({ description, externalTicketId: ticket, source: 'slack' }),
        slackChannelId: metadata.channelId || null,
        templateId: resolvedTemplate.templateId,
        templateVersion: resolvedTemplate.version,
      },
    },
    () =>
      fastify.temporal.startRunnableWorkflow(temporalWorkflowId, {
        request: repoWorkRequest,
        templateId: resolvedTemplate.templateId,
        templateVersion: resolvedTemplate.version,
      }),
    { log: fastify.log }
  );
  if (!launch.ok) {
    return {
      errors: { ticket_block: `Workflow already running for ${ticket}` },
      response_action: 'errors',
    };
  }

  // Closing the modal with no `response_action` dismisses it cleanly.
  return { response_action: 'clear' };
}
