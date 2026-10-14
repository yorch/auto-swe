import type { Role } from '@auto-swe/shared';
import { resolveRepoAccessGateOrLastKnown } from '@auto-swe/shared/lib/repoAccessGate';
import {
  resolveSlackBotTokenForWorkspace,
  resolveSlackConfig,
} from '@auto-swe/shared/lib/systemConfig';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildWorkflowRunControlFilter } from '../../lib/runVisibility.js';
import { openSlackView, verifySlackSignature } from '../../lib/slack.js';
import { handleAskMessageShortcut } from '../../lib/slack/channelEvents.js';
import { handleHitlModalSubmission, handleHitlResolveAction } from '../../lib/slack/hitlActions.js';
import { HITL_COMMENT_BLOCK, HITL_MODAL_CALLBACK_ID } from '../../lib/slack/hitlModal.js';
import { respondToInteraction } from '../../lib/slack/respond.js';
import {
  buildLinkAccountModalView,
  buildRunModalView,
  handleRunModalSubmission,
} from '../../lib/slack/runModal.js';
import type { SlackInteractivePayload } from '../../lib/slack/types.js';
import { hasRole } from '../../plugins/auth.js';

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

export async function registerInteractiveRoutes(fastify: FastifyInstance): Promise<void> {
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
}
