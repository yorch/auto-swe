import { prisma } from '@auto-swe/shared/db';

/**
 * Slack notifications. Three surfaces:
 *   - {@link notifySlackStepFailure} — per-step failure (phase 7)
 *   - {@link notifySlackPrReady}     — PR opened / ready for review (phase 7)
 *   - {@link notifySlackRunComplete} — terminal-run summary (phase 8, opt-in)
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

interface SlackChatPostMessageResponse {
  ok: boolean;
  error?: string;
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
  logLabel: string
): Promise<void> {
  const body: Record<string, unknown> = { channel, text };
  if (threadTs) {
    body.thread_ts = threadTs;
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
  const workRequest = await prisma.workRequest.findUnique({
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

/** Per-step failure notification (phase 7). Fires on the FIRST failed attempt only. */
export async function notifySlackStepFailure(input: {
  runId: string;
  nodeId: string;
  attempt: number;
  error?: string | undefined;
}): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
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
  const token = process.env.SLACK_BOT_TOKEN;
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

/**
 * Terminal-state notification (phase 8). Posts SUCCESS / final FAILED when the
 * team opts in via `Team.slackNotifySuccess = true`. Per-step failures still
 * fire via {@link notifySlackStepFailure} regardless of the opt-in.
 */
export async function notifySlackRunComplete(input: {
  runId: string;
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED';
}): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
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
