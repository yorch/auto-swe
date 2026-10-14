import {
  resolveSlackBotTokenForWorkspace,
  resolveSlackConfig,
} from '@auto-swe/shared/lib/systemConfig';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildRunModalView } from '../../lib/slack/runModal.js';
import {
  ephemeral,
  findTemplateByName,
  formatTemplateList,
  formatTemplateShow,
  listVisibleTemplates,
  slashHelpText,
} from '../../lib/slack/slashCommands.js';
import { openSlackView, verifySlackSignature } from '../../lib/slack.js';

export async function registerCommandRoutes(fastify: FastifyInstance): Promise<void> {
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
}
