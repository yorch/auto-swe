import { prisma } from '@auto-swe/shared/db';
import { resolveSlackConfig } from '@auto-swe/shared/lib/systemConfig';

/**
 * Slack notifications. Four surfaces:
 *   - {@link notifySlackStepFailure} — per-step failure (phase 7)
 *   - {@link notifySlackPrReady}     — PR opened / ready for review (phase 7)
 *   - {@link notifySlackRunComplete} — terminal-run summary (phase 8, opt-in)
 *   - {@link notifySlackHumanStep}   — HITL step pending, with inbox link
 *
 * Channel resolution is shared via {@link resolveSlackChannel}: prefer the
 * originating `WorkRequest.slackChannelId` (thread back to source); fall back
 * to `Team.slackNotifyChannel`. Cross-repo epics have multiple activeWorkflows
 * under one WorkRequest, so we match the run's `workflowId` against
 * `temporalWorkflowId` to pick the correct team (not an arbitrary first row).
 *
 * All functions are best-effort. They silently no-op when `SLACK_BOT_TOKEN`
 * is unset, no channel resolves, the fetch times out, or Slack returns
 * `{ok: false}` — never let a Slack outage block the calling activity.
 */

// Hard upper bound on the wall-clock cost of this best-effort path. Kept short
// because the caller awaits us; we'd rather miss a notification than slow
// every workflow during a Slack outage.
const SLACK_POST_TIMEOUT_MS = 2_000;
const SLACK_POST_URL = 'https://slack.com/api/chat.postMessage';
const SLACK_UPDATE_URL = 'https://slack.com/api/chat.update';

interface SlackChatPostMessageResponse {
  ok: boolean;
  error?: string;
  /** Timestamp of the posted/updated message — used by the live-edit (chat.update) flow. */
  ts?: string;
}

interface ResolvedChannel {
  channel: string;
  threadTs: string | null;
  ticket: string;
  templateName: string;
  /** Loaded only when we need to consult the team opt-in (`requireOptIn=true`). */
  teamSlackNotifySuccess: boolean;
}

/**
 * Look up the destination channel for a run. Returns `null` when the run has
 * no workspace context, no resolvable channel, or — for the run-complete path
 * — the team hasn't opted in (`requireOptIn=true`).
 */
async function resolveSlackChannel(
  runId: string,
  requireOptIn: boolean
): Promise<ResolvedChannel | null> {
  const run = await prisma.workflowRun.findUnique({
    include: {
      template: { select: { name: true } },
      workRequest: {
        include: {
          activeWorkflows: {
            include: { repository: { select: { teamId: true } } },
          },
        },
      },
    },
    where: { id: runId },
  });
  if (!run) {
    return null;
  }

  const ticket = run.workRequest?.externalTicketId ?? '(no ticket)';
  const templateName = run.template?.name ?? '(template)';

  let channel = run.workRequest?.slackChannelId ?? null;
  let threadTs = run.workRequest?.slackMessageTs ?? null;

  // The team row is needed by the run-complete path (opt-in gate) and by the
  // failure-fallback path (`slackNotifyChannel`). Load it once.
  const ownActive = run.workRequest?.activeWorkflows.find(
    (aw) => aw.temporalWorkflowId === run.workflowId
  );
  const teamId =
    ownActive?.repository?.teamId ??
    run.workRequest?.activeWorkflows[0]?.repository?.teamId ??
    null;
  const team = teamId
    ? await prisma.team.findUnique({
        select: { slackNotifyChannel: true, slackNotifySuccess: true },
        where: { id: teamId },
      })
    : null;

  if (requireOptIn && !team?.slackNotifySuccess) {
    return null;
  }

  if (!channel) {
    channel = team?.slackNotifyChannel ?? null;
    threadTs = null;
  }
  if (!channel) {
    return null;
  }

  return {
    channel,
    teamSlackNotifySuccess: team?.slackNotifySuccess ?? false,
    templateName,
    threadTs,
    ticket,
  };
}

async function postToSlack(
  token: string,
  channel: string,
  threadTs: string | null,
  text: string,
  logLabel: string,
  blocks?: unknown[]
): Promise<void> {
  const body: Record<string, unknown> = { channel, text };
  if (threadTs) {
    body.thread_ts = threadTs;
  }
  if (blocks && blocks.length > 0) {
    body.blocks = blocks;
  }

  // AbortController guards against a hung connection holding up the activity.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_POST_TIMEOUT_MS);
  try {
    const res = await fetch(SLACK_POST_URL, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      method: 'POST',
      signal: controller.signal,
    });
    // Slack returns 200 with `{ok: false, error: '...'}` on logical failures
    // (bad channel, missing scope, etc.). Surface those onto the activity log.
    const data = (await res.json().catch(() => ({}))) as SlackChatPostMessageResponse;
    if (!data.ok) {
      // eslint-disable-next-line no-console
      console.warn(`${logLabel}: chat.postMessage failed: ${data.error ?? 'unknown'}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a Slack channel directly from a WorkRequest row. Used by
 * {@link notifySlackPrReady} which is called from createOrUpdatePullRequest
 * (an activity that has the workRequestId, not a workflowRun id).
 */
async function resolveSlackChannelByWorkRequest(
  workRequestId: string
): Promise<{ channel: string; threadTs: string | null; ticket: string } | null> {
  const workRequest = await prisma.runInput.findUnique({
    include: {
      activeWorkflows: {
        include: { repository: { select: { teamId: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 1,
      },
    },
    where: { id: workRequestId },
  });
  if (!workRequest) {
    return null;
  }

  const ticket = workRequest.externalTicketId;
  let channel = workRequest.slackChannelId ?? null;
  let threadTs = workRequest.slackMessageTs ?? null;

  if (!channel) {
    const teamId = workRequest.activeWorkflows[0]?.repository?.teamId ?? null;
    const team = teamId
      ? await prisma.team.findUnique({
          select: { slackNotifyChannel: true },
          where: { id: teamId },
        })
      : null;
    channel = team?.slackNotifyChannel ?? null;
    threadTs = null;
  }

  if (!channel) {
    return null;
  }
  return { channel, threadTs, ticket };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Claude Tag (Phase 0): post a plain text reply into a Slack thread. Unlike the
 * best-effort notification surfaces above, this is the assistant's actual reply —
 * a failure to deliver matters — so it resolves the bot token via
 * {@link resolveSlackConfig} (never `process.env`) and throws on a missing token
 * or a `{ok:false}` response so the calling activity can retry / surface it.
 */
export async function postSlackThreadMessage(
  slackChannelId: string,
  threadTs: string,
  text: string
): Promise<void> {
  await postChannelMessage('postSlackThreadMessage', slackChannelId, text, threadTs);
}

/**
 * Claude Tag (Phase 4): post a threaded message and return its Slack timestamp
 * (`ts`). Used by the channel-assistant "live progress" flow to drop a
 * placeholder into the thread and later edit it in place via
 * {@link updateSlackMessage}. Same token resolution + throw-on-failure
 * semantics as {@link postSlackThreadMessage}.
 */
export async function postSlackThreadMessageReturningTs(
  slackChannelId: string,
  threadTs: string,
  text: string
): Promise<{ ts: string }> {
  const { ts } = await postChannelMessage(
    'postSlackThreadMessageReturningTs',
    slackChannelId,
    text,
    threadTs
  );
  if (!ts) {
    throw new Error('postSlackThreadMessageReturningTs: Slack returned no message ts');
  }
  return { ts };
}

/**
 * Claude Tag (Phase 4): edit an already-posted message in place via Slack
 * `chat.update`. Used to replace the channel-assistant placeholder with the
 * final reply (or a friendly error). Resolves the bot token via
 * {@link resolveSlackConfig} (never `process.env`) and throws on a missing
 * token or a `{ok:false}` response — same style as the other "real content"
 * helpers — so the calling activity can retry / surface it.
 */
export async function updateSlackMessage(
  slackChannelId: string,
  ts: string,
  text: string
): Promise<void> {
  const { botToken: token } = await resolveSlackConfig();
  if (!token) {
    throw new Error('updateSlackMessage: no Slack bot token configured');
  }

  const res = await fetch(SLACK_UPDATE_URL, {
    body: JSON.stringify({ channel: slackChannelId, text, ts }),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    method: 'POST',
  });
  const data = (await res.json().catch(() => ({}))) as SlackChatPostMessageResponse;
  if (!data.ok) {
    throw new Error(`updateSlackMessage: chat.update failed: ${data.error ?? 'unknown'}`);
  }
}

/**
 * Claude Tag (Phase 3): post a plain top-level (un-threaded) message into a Slack
 * channel. Used by the ambient digest, which posts proactively to the channel
 * rather than into a thread. Like {@link postSlackThreadMessage}, this is real
 * content (not a best-effort notification): it resolves the bot token via
 * {@link resolveSlackConfig} (never `process.env`) and throws on a missing token
 * or a `{ok:false}` response so the calling activity can surface it.
 */
export async function postSlackChannelMessage(slackChannelId: string, text: string): Promise<void> {
  await postChannelMessage('postSlackChannelMessage', slackChannelId, text, undefined);
}

/**
 * Shared base for the "real content" posts above. Resolves the bot token,
 * posts to `chat.postMessage` (threaded when `threadTs` is set, top-level
 * otherwise), and throws on a missing token or a `{ok:false}` response so the
 * caller can retry / surface it. Returns the posted message timestamp (`ts`)
 * for callers that need to edit it in place later (chat.update).
 */
async function postChannelMessage(
  label: string,
  slackChannelId: string,
  text: string,
  threadTs: string | undefined
): Promise<{ ts: string | undefined }> {
  const { botToken: token } = await resolveSlackConfig();
  if (!token) {
    throw new Error(`${label}: no Slack bot token configured`);
  }

  const body: Record<string, unknown> = { channel: slackChannelId, text };
  if (threadTs) {
    body.thread_ts = threadTs;
  }

  const res = await fetch(SLACK_POST_URL, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    method: 'POST',
  });
  const data = (await res.json().catch(() => ({}))) as SlackChatPostMessageResponse;
  if (!data.ok) {
    throw new Error(`${label}: chat.postMessage failed: ${data.error ?? 'unknown'}`);
  }
  return { ts: data.ts };
}

/** Per-step failure notification (phase 7). Fires on the FIRST failed attempt only. */
export async function notifySlackStepFailure(input: {
  runId: string;
  nodeId: string;
  attempt: number;
  error?: string | undefined;
}): Promise<void> {
  const { botToken: token } = await resolveSlackConfig();
  if (!token) {
    return;
  }
  // Notify only on the FIRST failure for a given (runId, nodeId). Retries that
  // keep failing would otherwise spam the channel.
  if (input.attempt > 1) {
    return;
  }

  try {
    const resolved = await resolveSlackChannel(input.runId, false);
    if (!resolved) {
      return;
    }
    const errLine = input.error ? `: ${truncate(input.error, 400)}` : '';
    const text = `*[${resolved.ticket}]* \`${resolved.templateName}\` → step \`${input.nodeId}\` failed (attempt ${input.attempt})${errLine}`;
    await postToSlack(token, resolved.channel, resolved.threadTs, text, 'slackNotify');
  } catch {
    /* best-effort */
  }
}

/**
 * PR "ready for review" notification (phase 7). Fires when a new PR is opened
 * so the originating Slack channel sees the link immediately. No opt-in needed
 * — mirrors the step-failure surface. Best-effort; silently no-ops on any error.
 */
export async function notifySlackPrReady(input: {
  workRequestId: string;
  prNumber: number;
  prUrl: string;
}): Promise<void> {
  const { botToken: token } = await resolveSlackConfig();
  if (!token) {
    return;
  }

  try {
    const ctx = await resolveSlackChannelByWorkRequest(input.workRequestId);
    if (!ctx) {
      return;
    }
    const text = `:eyes: *[${ctx.ticket}]* PR #${input.prNumber} is ready for review: ${input.prUrl}`;
    await postToSlack(token, ctx.channel, ctx.threadTs, text, 'slackNotify (pr-ready)');
  } catch {
    /* best-effort */
  }
}

// ── HITL Block Kit buttons ──────────────────────────────────────────────────
//
// Slack hard limits that shape buildHumanStepBlocks:
//   - button `text` ≤ 75 chars        → option labels truncated to 72 + '…'
//   - button `value` ≤ 2000 chars     → buttons whose value JSON would exceed
//     the cap are skipped (we never truncate the value itself — a truncated
//     option value would resolve the step with the WRONG payload)
//   - actions block ≤ 25 elements     → decision options capped well below
const SLACK_BUTTON_LABEL_MAX = 72;
const SLACK_BUTTON_VALUE_MAX = 2000;
const MAX_DECISION_OPTION_BUTTONS = 20;

/**
 * Gateway-side dispatch matches `action_id === 'hitl_resolve'` or the
 * `hitl_resolve:` prefix. The suffix exists only because Slack requires
 * action_ids to be unique within a block (two bare `hitl_resolve` buttons in
 * one actions block are rejected with `invalid_blocks`).
 */
export const HITL_RESOLVE_ACTION_ID = 'hitl_resolve';

interface SlackButton {
  type: 'button';
  action_id: string;
  text: { type: 'plain_text'; text: string; emoji?: boolean };
  value?: string;
  url?: string;
  style?: 'primary' | 'danger';
}

function hitlButton(
  idSuffix: string,
  label: string,
  payload: { stepId: string; action: string; value?: unknown },
  style?: 'primary' | 'danger'
): SlackButton | null {
  const value = JSON.stringify(payload);
  if (value.length > SLACK_BUTTON_VALUE_MAX) {
    return null;
  }
  const button: SlackButton = {
    action_id: `${HITL_RESOLVE_ACTION_ID}:${idSuffix}`,
    text: { text: truncate(label, SLACK_BUTTON_LABEL_MAX), type: 'plain_text' },
    type: 'button',
    value,
  };
  if (style) {
    button.style = style;
  }
  return button;
}

/**
 * Build the Block Kit blocks for a pending human step.
 *
 * Resolve buttons are attached only for kinds with enumerable actions:
 *   - APPROVAL → Approve / Reject
 *   - DECISION → one button per option (`action: 'select'`, value = option value)
 * INPUT and REVIEW need free-form payloads, so they stay link-only.
 * The "Open inbox" link button is always present. `stepId` is required for
 * resolve buttons — without it (e.g. the DB row couldn't be identified) the
 * message degrades to link-only.
 */
export function buildHumanStepBlocks(input: {
  kind: 'APPROVAL' | 'DECISION' | 'INPUT' | 'REVIEW';
  text: string;
  inboxUrl: string;
  stepId?: string | undefined;
  options?: Array<{ label: string; value: string }> | undefined;
}): unknown[] {
  const elements: SlackButton[] = [];

  if (input.stepId) {
    const stepId = input.stepId;
    if (input.kind === 'APPROVAL') {
      const approve = hitlButton('approve', 'Approve', { action: 'approve', stepId }, 'primary');
      const reject = hitlButton('reject', 'Reject', { action: 'reject', stepId }, 'danger');
      if (approve) {
        elements.push(approve);
      }
      if (reject) {
        elements.push(reject);
      }
    } else if (input.kind === 'DECISION') {
      const options = (input.options ?? []).slice(0, MAX_DECISION_OPTION_BUTTONS);
      for (const [i, option] of options.entries()) {
        const button = hitlButton(`select:${i}`, option.label, {
          action: 'select',
          stepId,
          value: option.value,
        });
        if (button) {
          elements.push(button);
        }
      }
    }
  }

  elements.push({
    action_id: 'open_inbox',
    text: { text: 'Open inbox', type: 'plain_text' },
    type: 'button',
    url: input.inboxUrl,
  });

  return [
    { text: { text: input.text, type: 'mrkdwn' }, type: 'section' },
    { elements, type: 'actions' },
  ];
}

/**
 * HITL "human step pending" notification. Fires when a workflow reaches an
 * approval/decision/input/review node so the team sees the pending step without
 * watching the inbox. No opt-in needed — mirrors the step-failure surface
 * (origin thread preferred, team channel fallback). Best-effort; silently
 * no-ops on any error.
 *
 * When `stepId` is provided, approval/decision steps get interactive Block Kit
 * buttons (`action_id` prefix `hitl_resolve`) that resolve the step directly
 * from Slack via the gateway's interactivity endpoint.
 */
export async function notifySlackHumanStep(input: {
  runId: string;
  kind: 'APPROVAL' | 'DECISION' | 'INPUT' | 'REVIEW';
  title: string;
  description?: string | undefined;
  stepId?: string | undefined;
  options?: Array<{ label: string; value: string }> | undefined;
}): Promise<void> {
  const { botToken: token } = await resolveSlackConfig();
  if (!token) {
    return;
  }

  try {
    const resolved = await resolveSlackChannel(input.runId, false);
    if (!resolved) {
      return;
    }
    const kindLabel: Record<string, string> = {
      APPROVAL: 'Approval required',
      DECISION: 'Decision required',
      INPUT: 'Input required',
      REVIEW: 'Review required',
    };
    const descriptionLine = input.description ? `\n${truncate(input.description, 400)}` : '';
    const inboxUrl = `${process.env.WEB_URL ?? 'http://localhost:3000'}/inbox`;
    const text = `:hourglass_flowing_sand: *[${resolved.ticket}]* *${kindLabel[input.kind] ?? input.kind}:* ${input.title}${descriptionLine}\n<${inboxUrl}|Open inbox →>`;
    const blocks = buildHumanStepBlocks({
      inboxUrl,
      kind: input.kind,
      options: input.options,
      stepId: input.stepId,
      text,
    });
    await postToSlack(
      token,
      resolved.channel,
      resolved.threadTs,
      text,
      'slackNotify (human-step)',
      blocks
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Terminal-state notification (phase 8). Posts SUCCESS / final FAILED when the
 * team opts in via `Team.slackNotifySuccess = true`. Per-step failures still
 * fire via {@link notifySlackStepFailure} regardless of the opt-in.
 */
export async function notifySlackRunComplete(input: {
  runId: string;
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED';
}): Promise<void> {
  const { botToken: token } = await resolveSlackConfig();
  if (!token) {
    return;
  }

  try {
    const resolved = await resolveSlackChannel(input.runId, true);
    if (!resolved) {
      return;
    }
    const emoji =
      input.status === 'SUCCESS'
        ? ':white_check_mark:'
        : input.status === 'CANCELLED'
          ? ':octagonal_sign:'
          : ':rotating_light:';
    const text = `${emoji} *[${resolved.ticket}]* \`${resolved.templateName}\` run finished: *${input.status}*`;
    await postToSlack(token, resolved.channel, resolved.threadTs, text, 'slackNotify (complete)');
  } catch {
    /* best-effort */
  }
}
