import { prisma } from '@auto-swe/shared/db';

/**
 * Phase-7 per-step failure notification. Best-effort, never throws.
 *
 * Resolution order for the target channel:
 *   1. The originating Slack channel on `WorkRequest.slackChannelId` (paired with
 *      `slackMessageTs` for thread continuity) — set when the work request was
 *      created via `/auto-swe run`.
 *   2. The team's configured `Team.slackNotifyChannel` — set via the team admin UI.
 *
 * Silently no-ops when `SLACK_BOT_TOKEN` is unset, no channel is resolvable,
 * or the API call fails. We never want a transient Slack outage to block the
 * `recordWorkflowStep` activity that drives every workflow run.
 */
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
              take: 1,
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
      const teamId = run.workRequest?.activeWorkflows[0]?.repository?.teamId;
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

    await fetch('https://slack.com/api/chat.postMessage', {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      method: 'POST',
    });
  } catch {
    // Best-effort. Never let a Slack failure surface as a workflow failure.
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
