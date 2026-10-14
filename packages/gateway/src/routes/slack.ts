import type { Role } from '@auto-swe/shared';
import { resolveRepoAccessGateOrLastKnown } from '@auto-swe/shared/lib/repoAccessGate';
import {
  resolveSlackBotTokenForWorkspace,
  resolveSlackConfig,
} from '@auto-swe/shared/lib/systemConfig';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { buildWorkflowRunControlFilter } from '../lib/runVisibility.js';
import { openSlackView, publishAppHome, verifySlackSignature } from '../lib/slack.js';
import { handleAskMessageShortcut, processChannelEvent } from '../lib/slack/channelEvents.js';
import { handleHitlModalSubmission, handleHitlResolveAction } from '../lib/slack/hitlActions.js';
import { HITL_COMMENT_BLOCK, HITL_MODAL_CALLBACK_ID } from '../lib/slack/hitlModal.js';
import { respondToInteraction } from '../lib/slack/respond.js';
import {
  buildLinkAccountModalView,
  buildRunModalView,
  handleRunModalSubmission,
} from '../lib/slack/runModal.js';
import {
  ephemeral,
  findTemplateByName,
  formatTemplateList,
  formatTemplateShow,
  listVisibleTemplates,
  slashHelpText,
} from '../lib/slack/slashCommands.js';
import type { SlackEventCallback, SlackInteractivePayload } from '../lib/slack/types.js';
import { hasRole } from '../plugins/auth.js';
import { registerOauthRoutes } from './slack/oauth.js';

/**
 * A Slack button carries the target workflow id in its `value`, which any
 * client can forge (or read from a forwarded message). Gate every signal on
 * the same run-control predicate the dashboard's cancel and human-step routes
 * use — control, not visibility: seeing a run does not entitle anyone to
 * approve its merge or drive its CI fixes.
 */
async function canControlRun(
  fastify: FastifyInstance,
  user: { id: string; role: Role },
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
      ...buildWorkflowRunControlFilter({ role: user.role, sub: user.id }, gate),
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

  await registerOauthRoutes(fastify);

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
      const isHitlModalSubmission =
        payload.type === 'view_submission' && payload.view?.callback_id === HITL_MODAL_CALLBACK_ID;
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

      // Resolve user by Slack ID. A deactivated account resolves to nobody: a
      // Slack link must not outlive the platform access it stands in for, and
      // every action below (HITL resolve, merge signal, run launch) acts as
      // this user.
      const user = await fastify.prisma.user.findFirst({
        where: { isActive: true, slackId: slackUserId },
      });

      if (!user) {
        if (isHitlModalSubmission) {
          // A modal has no response_url to carry a hint; an inline error is the one
          // surface that reaches the submitter.
          return {
            errors: {
              [HITL_COMMENT_BLOCK]:
                'Link your Slack account in Settings first — then you can resolve steps from Slack.',
            },
            response_action: 'errors',
          };
        }
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

      // View-submission: the approve / reject comment modal opened from a HITL button.
      if (isHitlModalSubmission) {
        return handleHitlModalSubmission(fastify, request, user, payload, signingSecret);
      }

      if (!actionId) {
        return { data: { ignored: true } };
      }

      // HITL resolve buttons posted by the worker's notifySlackHumanStep.
      // Shares the inbox route's resolve core (lib/hitlResolve.ts): same team
      // visibility, action validation, atomic guard, and signal rollback.
      if (isHitlResolve) {
        return handleHitlResolveAction(fastify, request, user, payload, signingSecret);
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
        if (!(await canControlRun(fastify, user, workflowId))) {
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
        if (!(await canControlRun(fastify, user, workflowId))) {
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
        ? await fastify.prisma.user.findFirst({ where: { isActive: true, slackId: slackUserId } })
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
