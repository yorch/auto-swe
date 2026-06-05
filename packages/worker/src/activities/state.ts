import type { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { resolveSlackConfig } from '@auto-swe/shared/lib/systemConfig';

/**
 * Upsert the workflow's current status. Workflows that lack a pre-existing
 * ActiveWorkflow row (e.g. epic-orchestrator workflows, or engineering workflows
 * spawned as children by an epic) self-register on their first state call.
 *
 * The gateway-created row, when present, already has repoId/workRequestId/etc.
 * — those columns are nullable so the create branch leaves them null and they
 * stay null forever for self-registered rows. That's intentional: the epic row
 * doesn't belong to a single repo, and child rows could backfill repoId later
 * via a separate code path if needed.
 */
export async function updateDomainState(temporalWorkflowId: string, status: string): Promise<void> {
  await prisma.activeWorkflow.upsert({
    create: { currentStatus: status, temporalWorkflowId },
    update: { currentStatus: status },
    where: { temporalWorkflowId },
  });
}

export async function resolveHumanStep(input: {
  runId: string;
  nodeId: string;
  status: 'TIMED_OUT';
}): Promise<void> {
  await prisma.workflowHumanStep.updateMany({
    data: { resolvedAt: new Date(), status: input.status },
    where: { nodeId: input.nodeId, runId: input.runId, status: 'PENDING' },
  });
}

export interface CreateHumanStepInput {
  runId: string;
  nodeId: string;
  signalName: string;
  kind: 'APPROVAL' | 'DECISION' | 'INPUT' | 'REVIEW';
  title: string;
  description?: string;
  context?: unknown;
  options?: Array<{ label: string; value: string }>;
  fields?: Array<{
    key: string;
    label: string;
    type: string;
    required?: boolean;
    options?: string[];
  }>;
}

const SLACK_POST_TIMEOUT_MS = 2_000;

/**
 * Create a WorkflowHumanStep record in the DB and send a best-effort Slack notification.
 * Called by the Temporal-backed dispatcher when a HITL node is reached.
 */
export async function createHumanStep(input: CreateHumanStepInput): Promise<void> {
  await prisma.workflowHumanStep.create({
    data: {
      context: input.context !== undefined ? (input.context as Prisma.InputJsonValue) : undefined,
      description: input.description,
      fields: input.fields ? (input.fields as Prisma.InputJsonValue) : undefined,
      kind: input.kind,
      nodeId: input.nodeId,
      options: input.options ? (input.options as Prisma.InputJsonValue) : undefined,
      runId: input.runId,
      signalName: input.signalName,
      title: input.title,
    },
  });

  // Best-effort Slack notification — resolve channel from the run's team.
  try {
    const slackConfig = await resolveSlackConfig();
    if (!slackConfig.botToken) {
      return;
    }

    // Find the team's Slack notify channel via the run → workRequest → activeWorkflows → team.
    const run = await prisma.workflowRun.findUnique({
      include: {
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

    const teamId = run?.workRequest?.activeWorkflows[0]?.repository?.teamId ?? null;
    const team = teamId
      ? await prisma.team.findUnique({
          select: { slackNotifyChannel: true },
          where: { id: teamId },
        })
      : null;
    const channel = team?.slackNotifyChannel ?? null;
    if (!channel) {
      return;
    }

    const kindLabel: Record<string, string> = {
      APPROVAL: 'Approval required',
      DECISION: 'Decision required',
      INPUT: 'Input required',
      REVIEW: 'Review required',
    };

    const ticket = run?.workRequest?.externalTicketId;
    const ticketPrefix = ticket ? `*[${ticket}]* ` : '';
    const descriptionLine = input.description ? `\n${input.description}` : '';
    const inboxUrl = `${process.env.WEB_URL ?? 'http://localhost:3000'}/inbox`;
    const text = `${ticketPrefix}*${kindLabel[input.kind] ?? input.kind}:* ${input.title}${descriptionLine}\n<${inboxUrl}|Open inbox →>`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_POST_TIMEOUT_MS);
    try {
      await fetch('https://slack.com/api/chat.postMessage', {
        body: JSON.stringify({ channel, text }),
        headers: {
          Authorization: `Bearer ${slackConfig.botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        method: 'POST',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Slack failure must not fail the activity
  }
}
