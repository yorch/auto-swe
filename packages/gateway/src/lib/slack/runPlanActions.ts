import type { Role } from '@auto-swe/shared';
import { resolveRepoAccessGateOrLastKnown } from '@auto-swe/shared/lib/repoAccessGate';
import {
  SLACK_RUN_PLAN_ACTION_ID,
  type SlackRunPlanClaims,
  verifySlackRunPlanToken,
} from '@auto-swe/shared/lib/slackRunPlanToken';
import {
  resolveSlackBotTokenForSlackChannel,
  resolveWebUrl,
} from '@auto-swe/shared/lib/systemConfig';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { escapeSlackMrkdwn } from '../hitlSlackSync.js';
import { startRunPlan } from '../runPlanStart.js';
import { postSlackMessage } from '../slack.js';
import { respondToInteraction } from './respond.js';
import type { SlackInteractivePayload } from './types.js';

export { SLACK_RUN_PLAN_ACTION_ID };

/**
 * The "Review plan" link button's action id. The `card_link_` prefix is what the interactivity
 * route acknowledges without a linked account: the button only opens a URL.
 */
export const RUN_PLAN_REVIEW_LINK_ACTION_ID = 'card_link_run_plan_review';

const TEXT = {
  alreadyUsed: ':information_source: This plan button was already used.',
  expired: ':hourglass: This plan button has expired. Ask me again to get a new one.',
  invalid: ':warning: This plan button is not valid. Ask me again to get a new one.',
  notYours: ':lock: Only the person whose request this is can generate its plan.',
  started:
    ':hourglass_flowing_sand: Generating your plan… Open *Review plan* in the thread to follow it. ' +
    'Nothing runs until you approve the plan in the dashboard.',
  startFailed: ':warning: I could not start the plan right now. Try again in a moment.',
} as const;

/** Refusal codes that mean the token's Idempotency-Key already started (or finished) a plan. */
const ALREADY_USED_CODES: ReadonlySet<string> = new Set([
  'IDEMPOTENCY_KEY_CONFLICT',
  'IDEMPOTENCY_KEY_MISMATCH',
]);

/** The dashboard page that follows a generation job (`/start?mode=plan&job=…`). */
export function planReviewUrl(jobId: string): string {
  return `${resolveWebUrl().replace(/\/+$/, '')}/start?mode=plan&job=${encodeURIComponent(jobId)}`;
}

/** Where the proposal was posted: the button's message must be in the channel and thread the token names. */
function postedWhereTokenSays(payload: SlackInteractivePayload, claims: SlackRunPlanClaims) {
  if (payload.channel?.id !== claims.channelId) {
    return false;
  }
  const threadTs = payload.message?.thread_ts ?? payload.message?.ts;
  return threadTs === claims.threadTs;
}

/**
 * The "Generate plan" button (`block_actions`, action id `run_plan_generate`).
 *
 * The button's `value` is a signed, expiring token (`@auto-swe/shared/lib/slackRunPlanToken`)
 * posted by the channel assistant's fixed code. This handler:
 *
 * 1. verifies the token's signature and expiry;
 * 2. requires the clicker to be the person the token names and the click to come from the message
 *    in the channel and thread it was posted in;
 * 3. starts generation through `startRunPlan`, the function `POST /run-plans` calls, as the platform
 *    user the clicker's Slack id links to (the interactivity route has already refused an unlinked
 *    or deactivated one): role, repository reach, quotas, kill switch and launchable agents are the
 *    route's own, and never the channel's or a service identity;
 * 4. consumes the token by starting the job under an Idempotency-Key derived from its id. Temporal
 *    allows one job per workflow id, so a second click finds the first one's job and is answered
 *    "already used"; a click refused before the job starts (a quota, say) consumes nothing.
 *
 * It never approves a plan or launches a run: the plan is reviewed and approved in the dashboard.
 * The goal text lives only in the token and the job's input; no log line or reply here carries it.
 */
export async function handleRunPlanGenerateAction(
  fastify: FastifyInstance,
  request: FastifyRequest,
  user: { id: string; role: Role },
  payload: SlackInteractivePayload,
  signingSecret: string
): Promise<unknown> {
  const ack = (ok: boolean, reason: string) => ({
    data: { action: SLACK_RUN_PLAN_ACTION_ID, ok, reason },
  });
  const refuse = async (text: string, reason: string) => {
    await respondToInteraction(payload, text, { ephemeral: true });
    return ack(false, reason);
  };

  const verified = verifySlackRunPlanToken(payload.actions?.[0]?.value, signingSecret);
  if (!verified.ok) {
    return refuse(verified.issue === 'expired' ? TEXT.expired : TEXT.invalid, verified.issue);
  }
  const { claims } = verified;

  if (payload.user?.id !== claims.slackUserId) {
    return refuse(TEXT.notYours, 'not_creator');
  }
  if (!postedWhereTokenSays(payload, claims)) {
    return refuse(TEXT.invalid, 'wrong_message');
  }

  let started: Awaited<ReturnType<typeof startRunPlan>>;
  try {
    started = await startRunPlan(
      fastify,
      {
        // Slack authenticates by request signature, so there is no `request.repoAccessGate` to
        // inherit; leaving it out would make this button a way past the dashboard's check.
        gate: (await resolveRepoAccessGateOrLastKnown()) ?? undefined,
        log: request.log,
      },
      {
        agent: claims.agentKey ?? undefined,
        idempotencyKey: `slack-run-plan:${claims.jti}`,
        intent: claims.intent,
        repoId: claims.repoId,
        source: 'slack',
        user: { exp: 0, iat: 0, role: user.role, sub: user.id },
      }
    );
  } catch (err) {
    request.log.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'slack run plan generation could not be started'
    );
    return refuse(TEXT.startFailed, 'start_failed');
  }

  if (!started.ok) {
    if (ALREADY_USED_CODES.has(started.code)) {
      return refuse(TEXT.alreadyUsed, 'already_used');
    }
    return refuse(`:lock: ${escapeSlackMrkdwn(started.message)}`, started.code);
  }
  if (started.deduplicated) {
    return refuse(TEXT.alreadyUsed, 'already_used');
  }

  await respondToInteraction(payload, TEXT.started, { ephemeral: true });
  await postReviewLink(claims, started.jobId, request);
  return ack(true, 'started');
}

/** The thread message with the "Review plan" link button. Best effort: the job is already running. */
async function postReviewLink(
  claims: SlackRunPlanClaims,
  jobId: string,
  request: FastifyRequest
): Promise<void> {
  try {
    const token = await resolveSlackBotTokenForSlackChannel(claims.channelId);
    const text =
      ':hourglass_flowing_sand: Generating a plan. Review and approve it in the dashboard; nothing runs until it is approved.';
    await postSlackMessage(
      {
        blocks: [
          { text: { text, type: 'mrkdwn' }, type: 'section' },
          {
            elements: [
              {
                action_id: RUN_PLAN_REVIEW_LINK_ACTION_ID,
                text: { emoji: true, text: 'Review plan', type: 'plain_text' },
                type: 'button',
                url: planReviewUrl(jobId),
              },
            ],
            type: 'actions',
          },
        ],
        channel: claims.channelId,
        text,
        threadTs: claims.threadTs,
      },
      token ?? undefined
    );
  } catch (err) {
    request.log.warn(
      { err: err instanceof Error ? err.name : 'unknown', jobId },
      'slack run plan review link could not be posted'
    );
  }
}
