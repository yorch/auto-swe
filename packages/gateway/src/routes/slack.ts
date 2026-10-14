import {
  resolveSlackBotTokenForWorkspace,
  resolveSlackConfig,
} from '@auto-swe/shared/lib/systemConfig';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { openSlackView, publishAppHome, verifySlackSignature } from '../lib/slack.js';
import { processChannelEvent } from '../lib/slack/channelEvents.js';
import { buildRunModalView } from '../lib/slack/runModal.js';
import {
  ephemeral,
  findTemplateByName,
  formatTemplateList,
  formatTemplateShow,
  listVisibleTemplates,
  slashHelpText,
} from '../lib/slack/slashCommands.js';
import type { SlackEventCallback } from '../lib/slack/types.js';
import { registerInteractiveRoutes } from './slack/interactive.js';
import { registerOauthRoutes } from './slack/oauth.js';

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

  await registerInteractiveRoutes(fastify);

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
