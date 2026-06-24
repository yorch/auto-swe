import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { isChannelOverBudgetNow } from './channelAssistant.js';

/**
 * Channel assistant (Phase A): launch a durable, thread-bound task run from a
 * channel @mention the assistant judged to be a task (via the `delegateTask`
 * tool). This activity does the DB-side preparation — create the `RunInput` row,
 * resolve the channel's team/org + the "Channel Task" template — and returns
 * everything the `ChannelAssistantWorkflow` needs to `startChild('RunnableWorkflow')`.
 *
 * Why an activity (not done inline in the workflow): it touches the DB and the
 * config tables, which must stay outside the V8 workflow isolate. The workflow
 * is left with only the deterministic `startChild` call.
 *
 * MUST match `CHANNEL_TASK_TEMPLATE_NAME` in
 * `packages/shared/src/lib/syncBuiltins.ts` (where the template + its v1 spec are
 * seeded). Redeclared here rather than imported because the shared
 * `./lib/syncBuiltins` subpath isn't aliased for vitest; the name is the stable
 * lookup key (`findFirst({ name, teamId: null })`).
 */
const CHANNEL_TASK_TEMPLATE_NAME = 'Channel Task';

export interface CreateChannelTaskRunInput {
  /** SlackChannel.id (our row) — drives the CHANNEL config tier + budget accrual. */
  channelId: string;
  /** Slack channel id (`C…`) the result is threaded back into. */
  slackChannelId: string;
  /** Thread to report the result in (the originating mention's ts/thread_ts). */
  threadTs: string;
  /** Short title for the task (from the delegate intent). */
  title: string;
  /** Self-contained task description the run executes. */
  description: string;
}

export interface CreateChannelTaskRunResult {
  /** Deterministic Temporal workflowId for the task run (one per thread). */
  workflowId: string;
  templateId: string;
  templateVersion: number;
  /** The fully-formed run request the child `RunnableWorkflow` consumes. */
  request: RepoWorkRequest;
}

/**
 * Channel assistant (Phase A): is the channel over its monthly assistant budget
 * right now? A thin activity wrapper over {@link isChannelOverBudgetNow} (reads
 * the channel cap, then the month-to-date accrual) so the workflow can gate a
 * task launch without doing DB work inside the V8 isolate. Returns `false` when
 * no cap is set (the no-cap fast path) or the channel row is missing.
 */
export async function isChannelOverBudgetForTask(channelId: string): Promise<boolean> {
  const channel = await prisma.slackChannel.findUnique({
    select: { monthlyBudgetUsdCents: true },
    where: { id: channelId },
  });
  return isChannelOverBudgetNow(channelId, channel?.monthlyBudgetUsdCents ?? null);
}

/**
 * Sanitize a string into a Temporal-id-safe fragment. Temporal accepts most
 * characters but Slack channel/thread ids contain `.`/uppercase which we keep
 * deterministic by normalising to `[A-Za-z0-9_-]`. Collapses runs of disallowed
 * chars to a single `-` so the id stays readable and stable per (channel, thread).
 */
function sanitizeIdPart(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, '-');
}

/**
 * Resolve the GLOBAL "Channel Task" template's id + active version (seeded by
 * `syncBuiltins`). Throws if it's missing — a seed/bootstrap error the caller
 * should surface, not silently swallow.
 */
async function resolveChannelTaskTemplate(): Promise<{
  templateId: string;
  templateVersion: number;
}> {
  const template = await prisma.workflowTemplate.findFirst({
    select: { activeVersion: true, id: true },
    where: { name: CHANNEL_TASK_TEMPLATE_NAME, teamId: null },
  });
  if (!template?.activeVersion) {
    throw new Error(
      `no active "${CHANNEL_TASK_TEMPLATE_NAME}" workflow template — run \`yarn db:seed\``
    );
  }
  return { templateId: template.id, templateVersion: template.activeVersion };
}

/**
 * Create the `RunInput` row + assemble the child-workflow launch parameters for a
 * channel-launched task. The `RunInput` carries `slackChannelId` + `slackMessageTs`
 * (= the thread ts) so the run's terminal Slack notification threads the result
 * back into the originating conversation (see `slackNotify.resolveSlackChannel`).
 *
 * The returned `request` uses a sentinel `repoId: ''` — the Channel Task spec is
 * repo-less (its `agent` node needs no workspace) — and carries `channelId` so the
 * run's `agent` node resolves the CHANNEL config tier and its cost accrues to the
 * channel's monthly budget at finalize.
 */
export async function createChannelTaskRun(
  input: CreateChannelTaskRunInput
): Promise<CreateChannelTaskRunResult> {
  const { templateId, templateVersion } = await resolveChannelTaskTemplate();

  const externalTicketId = `slack-${input.slackChannelId}-${input.threadTs}`;

  // Persist a RunInput so notifications can thread back to Slack. `payload`
  // carries the channel context for observability/forward use; the typed
  // columns (`slackChannelId`/`slackMessageTs`) are what `resolveSlackChannel`
  // reads to thread the terminal notification.
  const runInput = await prisma.runInput.create({
    data: {
      description: input.description,
      externalTicketId,
      payload: {
        channelId: input.channelId,
        kind: 'channel-task',
        slackChannelId: input.slackChannelId,
        threadTs: input.threadTs,
        title: input.title,
      },
      requestPayload: input.description,
      slackChannelId: input.slackChannelId,
      slackMessageTs: input.threadTs,
      templateId,
      templateVersion,
    },
  });

  // Deterministic workflowId: one task run per thread. A reject-duplicate reuse
  // policy on `startChild` then makes a second delegate in the same thread a
  // no-op rather than a clobber.
  const workflowId = `chantask-${sanitizeIdPart(input.channelId)}-${sanitizeIdPart(input.threadTs)}`;

  const request: RepoWorkRequest = {
    channelId: input.channelId,
    description: input.description,
    externalTicketId,
    // Sentinel: the Channel Task spec is repo-less (agent node needs no workspace).
    repoId: '',
    requestPayload: input.description,
    slackChannel: input.threadTs,
    workRequestId: runInput.id,
  };

  return { request, templateId, templateVersion, workflowId };
}
