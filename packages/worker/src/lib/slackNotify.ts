import { prisma } from '@auto-swe/shared/db';

/**
 * Phase-7 per-step failure notification. Best-effort, never throws.
 *
 * Resolution order for the target channel:
 *   1. The originating Slack channel on `WorkRequest.slackChannelId` (paired with
 *      `slackMessageTs` for thread continuity if set — the modal-submit flow
 *      doesn't currently post an initial message, so `slackMessageTs` is null
 *      for those runs and the failure posts unthreaded into the originating
 *      channel; webhook-created work requests can pre-populate it for threading).
 *   2. The team's configured `Team.slackNotifyChannel`. Resolved by matching the
 *      current `WorkflowRun.workflowId` against `ActiveWorkflow.temporalWorkflowId`
 *      so cross-repo epics (multiple activeWorkflows under one WorkRequest)
 *      route to the correct team — not an arbitrary `take: 1` row.
 *
 * Silently no-ops when `SLACK_BOT_TOKEN` is unset, no channel is resolvable,
 * the fetch times out, or Slack returns `{ok: false}`. We never want a Slack
 * outage to block the `recordWorkflowStep` activity that drives every run.
 */

// Hard upper bound on the wall-clock cost of this best-effort path. Kept short
// because `recordWorkflowStep` awaits us; we'd rather miss a notification than
// slow every workflow's step recording during a Slack outage.
const SLACK_POST_TIMEOUT_MS = 2_000;

interface SlackChatPostMessageResponse {
  ok: boolean;
  error?: string;
}

export async function notifySlackStepFailure(input: {
  runId: string;
  nodeId: string;
  attempt: number;
  error?: string | undefined;
}): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;

  // Notify only on the FIRST failure for a given (runId, nodeId). Retries that
  // keep failing would otherwise spam the channel. The final-failure surface is
  // the FAILED workflow_runs row (caller can post once on finalizeWorkflowRun
  // in a follow-up).
  if (input.attempt > 1) return;

  try {
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
      where: { id: input.runId },
    });
    if (!run) return;

    // Prefer the originating channel; fall back to team notify channel.
    let channel = run.workRequest?.slackChannelId ?? null;
    let threadTs = run.workRequest?.slackMessageTs ?? null;
    if (!channel) {
      // Match the specific ActiveWorkflow corresponding to THIS run rather than
      // an arbitrary first row — epic decompositions have multiple
      // activeWorkflows under one WorkRequest, each with its own repo + team.
      const ownActive = run.workRequest?.activeWorkflows.find(
        (aw) => aw.temporalWorkflowId === run.workflowId
      );
      const teamId =
        ownActive?.repository?.teamId ??
        run.workRequest?.activeWorkflows[0]?.repository?.teamId ??
        null;
      if (teamId) {
        const team = await prisma.team.findUnique({
          select: { slackNotifyChannel: true },
          where: { id: teamId },
        });
        channel = team?.slackNotifyChannel ?? null;
        threadTs = null;
      }
    }
    if (!channel) return;

    const ticket = run.workRequest?.externalTicketId ?? '(no ticket)';
    const tpl = run.template?.name ?? '(template)';
    const errLine = input.error ? `: ${truncate(input.error, 400)}` : '';
    const text = `*[${ticket}]* \`${tpl}\` → step \`${input.nodeId}\` failed (attempt ${input.attempt})${errLine}`;

    const body: Record<string, unknown> = { channel, text };
    if (threadTs) body.thread_ts = threadTs;

    // AbortController guards against a hung connection holding up the activity.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_POST_TIMEOUT_MS);
    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        method: 'POST',
        signal: controller.signal,
      });
      // Slack returns 200 with `{ok: false, error: '...'}` on logical failures
      // (bad channel, missing scope, etc.). Surface those onto the activity log
      // by reading `ok` — we still don't throw, since the activity must succeed.
      const data = (await res.json().catch(() => ({}))) as SlackChatPostMessageResponse;
      if (!data.ok) {
        // eslint-disable-next-line no-console
        console.warn(`slackNotify: chat.postMessage failed: ${data.error ?? 'unknown'}`);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Best-effort. Never let a Slack failure surface as a workflow failure.
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
