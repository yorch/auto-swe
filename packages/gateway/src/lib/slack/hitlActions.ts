import type { Role } from '@auto-swe/shared';
import { resolveRepoAccessGateOrLastKnown } from '@auto-swe/shared/lib/repoAccessGate';
import { resolveSlackBotTokenForWorkspace } from '@auto-swe/shared/lib/systemConfig';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  HITL_REJECT_REASON_MIN,
  type HitlResolveErrorCode,
  resolveHitlStep,
} from '../hitlResolve.js';
import { syncSlackHumanStepOutcome } from '../hitlSlackSync.js';
import { buildWorkflowHumanStepControlFilter } from '../runVisibility.js';
import { openSlackView } from '../slack.js';
import {
  buildHitlCommentModalView,
  HITL_COMMENT_BLOCK,
  HITL_COMMENT_INPUT,
  HITL_COMMENT_MAX,
  HITL_MODAL_PRIVATE_METADATA_MAX,
  type HitlModalMetadata,
  signHitlModalMetadata,
  verifyHitlModalMetadata,
} from './hitlModal.js';
import { respondToInteraction } from './respond.js';
import type { SlackInteractivePayload } from './types.js';

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
export async function handleHitlResolveAction(
  fastify: FastifyInstance,
  request: FastifyRequest,
  user: { id: string; role: Role },
  payload: SlackInteractivePayload,
  signingSecret: string
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

  // Approve, reject and request-changes collect a note first, as the dashboard does: reject and
  // request_changes need a reason and an approve may carry a comment. Every other action (a
  // decision option) resolves in one click.
  if (
    parsed.action === 'approve' ||
    parsed.action === 'reject' ||
    parsed.action === 'request_changes'
  ) {
    return openHitlCommentModal(fastify, user, payload, signingSecret, {
      action: parsed.action,
      stepId: parsed.stepId,
    });
  }

  const outcome = await resolveHitlStepFromSlack(
    fastify,
    request,
    user,
    {
      channelId: payload.channel?.id,
      messageTs: payload.message?.ts,
      slackUserId: payload.user?.id,
    },
    payload,
    { action: parsed.action, stepId: parsed.stepId, value: parsed.value }
  );
  if (outcome.ok) {
    return { data: outcome.data };
  }
  await respondToInteraction(payload, hitlErrorText(outcome.code, outcome.message), {
    ephemeral: true,
  });
  return { data: { action: 'hitl_resolve', code: outcome.code, ok: false } };
}

interface HitlResolveTarget {
  stepId: string;
  action: string;
  value?: unknown;
  comment?: string | undefined;
}

type HitlSlackOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: HitlResolveErrorCode; message: string };

/**
 * The resolve core shared by the one-click buttons and the comment modal: authorization and
 * validation live in `resolveHitlStep`, and on success the thread confirmation and the
 * announcement edit follow. Nothing here trusts the caller's description of the step — the clicker
 * is the platform user the Slack id maps to, and the step is looked up under that user's control
 * filter every time.
 */
async function resolveHitlStepFromSlack(
  fastify: FastifyInstance,
  request: FastifyRequest,
  user: { id: string; role: Role },
  where: {
    channelId: string | undefined;
    messageTs: string | undefined;
    slackUserId: string | undefined;
  },
  interaction: SlackInteractivePayload,
  target: HitlResolveTarget
): Promise<HitlSlackOutcome> {
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
    target.stepId,
    target.action,
    target.value,
    { role: user.role, sub: user.id },
    target.comment
  );
  if (!result.ok) {
    return { code: result.code, message: result.message, ok: false };
  }

  const who = where.slackUserId ? `<@${where.slackUserId}>` : 'someone';
  const actionWord = target.action.replaceAll('_', ' ');
  let text: string;
  if (result.status === 'PENDING') {
    text = `:hourglass: *${result.title}* — ${who} recorded \`${actionWord}\` (${result.currentApprovers}/${result.requiredApprovers}). ${result.approvalsRemaining} more approval${result.approvalsRemaining === 1 ? '' : 's'} needed.`;
  } else if (result.signalSent) {
    text = `:white_check_mark: *${result.title}* — resolved with \`${actionWord}\` by ${who} (${result.currentApprovers}/${result.requiredApprovers}).`;
  } else {
    text = `:white_check_mark: *${result.title}* — recorded as \`${actionWord}\` by ${who} (${result.currentApprovers}/${result.requiredApprovers}), but the workflow run had already finished, so nothing was signalled.`;
  }
  if (result.status === 'RESOLVED') {
    // Replaces the buttons with the decision, so a decided step reads as decided in place.
    // Not awaited: Slack wants the interaction acknowledged within seconds, and this never throws.
    void syncSlackHumanStepOutcome({ log: request.log, prisma: fastify.prisma }, result.stepId, {
      action: target.action,
      comment: target.comment,
      userId: user.id,
      value: target.value,
    });
  }
  // A modal submission carries no response_url, so a pending-approval note goes to the thread too.
  // Not awaited: it costs a token lookup and a chat.postMessage, Slack wants the submission
  // acknowledged within seconds, and the decision is already recorded. It never throws.
  void respondToInteraction(
    {
      ...interaction,
      ...(where.channelId ? { channel: { id: where.channelId } } : {}),
      ...(where.messageTs ? { message: { ts: where.messageTs } } : {}),
    },
    text,
    { ephemeral: result.status === 'PENDING' && Boolean(interaction.response_url) }
  );
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
    ok: true,
  };
}

/**
 * Open the approve / reject modal for a button click. `views.open` needs the interaction's
 * `trigger_id` within three seconds, so the only work before it is one indexed lookup: the step
 * under the clicker's control filter. Opening is not the authorization — the submission resolves
 * through `resolveHitlStep`, which checks again — but refusing here spares the clicker a form
 * that cannot succeed and keeps the step title out of a modal for someone who cannot act on it.
 */
async function openHitlCommentModal(
  fastify: FastifyInstance,
  user: { id: string; role: Role },
  payload: SlackInteractivePayload,
  signingSecret: string,
  target: { stepId: string; action: 'approve' | 'reject' | 'request_changes' }
): Promise<unknown> {
  const ignored = (reason: string) => ({ data: { action: 'hitl_resolve', ignored: true, reason } });
  if (!payload.trigger_id) {
    await respondToInteraction(
      payload,
      ':warning: Slack did not provide what is needed to open the form — please try again.',
      {
        ephemeral: true,
      }
    );
    return ignored('missing_trigger_id');
  }
  const gate = (await resolveRepoAccessGateOrLastKnown()) ?? undefined;
  const step = await fastify.prisma.workflowHumanStep.findFirst({
    select: { id: true, status: true, title: true },
    where: {
      id: target.stepId,
      ...buildWorkflowHumanStepControlFilter({ role: user.role, sub: user.id }, gate),
    },
  });
  if (!step) {
    await respondToInteraction(payload, hitlErrorText('NOT_FOUND', ''), { ephemeral: true });
    return ignored('not_found');
  }
  if (step.status !== 'PENDING') {
    await respondToInteraction(payload, hitlErrorText('ALREADY_RESOLVED', ''), { ephemeral: true });
    return ignored('already_resolved');
  }
  const metadata: HitlModalMetadata = {
    action: target.action,
    slackUserId: payload.user?.id ?? '',
    stepId: step.id,
    ...(payload.channel?.id ? { channelId: payload.channel.id } : {}),
    ...(payload.message?.ts ? { messageTs: payload.message.ts } : {}),
  };
  const privateMetadata = signHitlModalMetadata(metadata, signingSecret);
  if (privateMetadata.length > HITL_MODAL_PRIVATE_METADATA_MAX) {
    return ignored('metadata_too_large');
  }
  const botToken = await resolveSlackBotTokenForWorkspace(payload.team?.id ?? '');
  const opened = await openSlackView(
    {
      triggerId: payload.trigger_id,
      view: buildHitlCommentModalView({
        action: target.action,
        privateMetadata,
        stepTitle: step.title,
      }),
    },
    botToken ?? undefined
  );
  if (!opened.ok) {
    await respondToInteraction(
      payload,
      ':warning: Could not open the form — please resolve the step from the inbox instead.',
      { ephemeral: true }
    );
    return ignored(opened.error ?? 'views_open_failed');
  }
  return { data: { action: 'hitl_resolve', modalOpened: true, stepId: step.id } };
}

/**
 * The approve / reject modal closing with a submit. Slack's request signature has already been
 * verified by the route; `private_metadata` additionally must carry our signature and name the
 * submitting Slack user. Failures come back as `response_action: errors` so the person sees them
 * in the form instead of a silent dismissal.
 */
export async function handleHitlModalSubmission(
  fastify: FastifyInstance,
  request: FastifyRequest,
  user: { id: string; role: Role },
  payload: SlackInteractivePayload,
  signingSecret: string
): Promise<unknown> {
  const fail = (message: string) => ({
    errors: { [HITL_COMMENT_BLOCK]: message },
    response_action: 'errors',
  });
  const metadata = verifyHitlModalMetadata(payload.view?.private_metadata, signingSecret);
  if (!metadata || metadata.slackUserId !== payload.user?.id) {
    return fail('This form is no longer valid — close it and use the buttons in Slack again.');
  }

  const typed = (
    payload.view?.state?.values?.[HITL_COMMENT_BLOCK]?.[HITL_COMMENT_INPUT]?.value ?? ''
  ).trim();
  if (
    (metadata.action === 'reject' || metadata.action === 'request_changes') &&
    typed.length < HITL_REJECT_REASON_MIN
  ) {
    return fail(`Give a reason of at least ${HITL_REJECT_REASON_MIN} characters.`);
  }
  if (typed.length > HITL_COMMENT_MAX) {
    return fail(`Keep this under ${HITL_COMMENT_MAX} characters.`);
  }

  const outcome = await resolveHitlStepFromSlack(
    fastify,
    request,
    user,
    { channelId: metadata.channelId, messageTs: metadata.messageTs, slackUserId: payload.user?.id },
    payload,
    {
      action: metadata.action,
      ...(typed ? { comment: typed } : {}),
      stepId: metadata.stepId,
    }
  );
  if (!outcome.ok) {
    return fail(hitlErrorText(outcome.code, outcome.message).replace(/^:\w+:\s*/, ''));
  }
  // An empty 200 closes the modal.
  return '';
}

export function hitlErrorText(code: HitlResolveErrorCode, message: string): string {
  switch (code) {
    case 'ALREADY_RESOLVED':
      return ':information_source: This step has already been resolved — nothing left to do.';
    case 'NOT_FOUND':
      return ':warning: This step no longer exists or is not visible to you.';
    case 'RUN_NOT_RUNNING':
      return ':warning: The workflow run is no longer running.';
    case 'SIGNAL_FAILED':
      return ':warning: Could not deliver your response to the workflow — please try the button again.';
    case 'TEMPORAL_UNAVAILABLE':
      return ':warning: This is temporarily unavailable — please try again in a moment.';
    default:
      return `:warning: ${message}`;
  }
}
