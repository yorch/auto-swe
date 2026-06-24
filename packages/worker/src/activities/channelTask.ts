import { prisma } from '@auto-swe/shared/db';
import { isGitRepoConnection } from '@auto-swe/shared/lib/connectionGuards';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { isChannelOverBudgetNow } from './channelAssistant.js';
import { resolveTemplateForRepo } from './templates.js';

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

/**
 * Channel assistant (Phase B): resolve which `git_repo` Connection a code task in
 * this channel should run against.
 *
 * Query the channel team's active `git_repo` connections, then:
 *  (a) if `repoHint` case-insensitively matches a connection's `repoName` or its
 *      `organizationName/repoName`, use that connection;
 *  (b) else, if the team has EXACTLY ONE active `git_repo` connection, use it
 *      (the unambiguous default — most channels map to one repo);
 *  (c) else return `null` (ambiguous: multiple repos and no/unmatched hint, or
 *      the team has no repo at all). The caller then falls back to the general
 *      Channel Task route.
 *
 * The `isGitRepoConnection` guard narrows out any `git_repo` row missing
 * org/repo identity before matching.
 */
export async function resolveChannelRepo(
  channelId: string,
  repoHint?: string
): Promise<{ repoId: string } | null> {
  const channel = await prisma.slackChannel.findUnique({
    select: { teamId: true },
    where: { id: channelId },
  });
  if (!channel) {
    return null;
  }

  const rows = await prisma.connection.findMany({
    select: { id: true, organizationName: true, repoName: true, type: true },
    where: { isActive: true, teamId: channel.teamId, type: 'git_repo' },
  });
  const repos = rows.filter(isGitRepoConnection);
  if (repos.length === 0) {
    return null;
  }

  // (a) Hint match: accept either the bare `repoName` or `organizationName/repoName`.
  const hint = repoHint?.trim().toLowerCase();
  if (hint) {
    const match = repos.find(
      (r) =>
        r.repoName.toLowerCase() === hint ||
        `${r.organizationName}/${r.repoName}`.toLowerCase() === hint
    );
    if (match) {
      return { repoId: match.id };
    }
  }

  // (b) Exactly one repo → unambiguous default.
  if (repos.length === 1) {
    return { repoId: repos[0].id };
  }

  // (c) Ambiguous (multiple repos, no/unmatched hint) → caller falls back.
  return null;
}

export interface CreateChannelCodeTaskRunInput {
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
  /** Optional repo the user named (matched in {@link resolveChannelRepo}). */
  repoHint?: string;
}

/**
 * Channel assistant (Phase B): prepare a CODE task run — launch the team's default
 * SWE workflow (real implement → review → PR) against the channel's resolved repo,
 * rather than the repo-less general Channel Task spec.
 *
 * Differences from {@link createChannelTaskRun}:
 *  - Resolves a real `git_repo` Connection via {@link resolveChannelRepo}; returns
 *    `null` when no repo resolves (the caller then falls back to the general route).
 *  - Resolves the team's DEFAULT SWE template via {@link resolveTemplateForRepo}
 *    (team `isDefault` ACTIVE template → GLOBAL `isDefault` fallback) instead of the
 *    named "Channel Task" template.
 *  - Builds a REAL {@link RepoWorkRequest} (real `repoId`) so the SWE spec's
 *    implementer/reviewer/PR nodes have a workspace to operate in.
 *
 * Shared with the general route: the deterministic per-thread `workflowId`
 * (`chantask-<channelId>-<threadTs>` — one task run per thread regardless of
 * route), the `RunInput` with `slackChannelId`/`slackMessageTs` set (so the run's
 * terminal Slack notification threads back), and `payload.kind === 'channel-task'`
 * so {@link finalizeChannelTaskRun} still accrues the run's cost to the channel
 * budget + posts the result back into the thread.
 *
 * ORG vs CHANNEL accrual (no double-count): a code run has a real
 * connection→team→org path, so `finalizeWorkflowRun` increments `OrgMonthlyUsage`
 * ONCE via that path (the normal SWE billing). The channel accrual done by
 * `finalizeChannelTaskRun` reads the run's `AgentTrace` cost into the SEPARATE
 * `ChannelMonthlyUsage` ledger (the per-channel budget) — a different table, so it
 * is additive/independent, not a second org increment. We do NOT touch
 * `OrgMonthlyUsage` here; the standard repo-bound finalize path owns that.
 */
export async function createChannelCodeTaskRun(
  input: CreateChannelCodeTaskRunInput
): Promise<CreateChannelTaskRunResult | null> {
  const repo = await resolveChannelRepo(input.channelId, input.repoHint);
  if (!repo) {
    // No (unambiguous) repo — signal the caller to fall back to the general route.
    return null;
  }

  // Default SWE template: team `isDefault` ACTIVE → GLOBAL `isDefault` fallback.
  const { templateId, templateVersion } = await resolveTemplateForRepo(repo.repoId);

  const externalTicketId = `slack-${input.slackChannelId}-${input.threadTs}`;

  // Persist a RunInput so the terminal Slack notification threads back. `payload`
  // carries the channel context (`kind: 'channel-task'`) so `finalizeChannelTaskRun`
  // accrues to the channel budget + posts the result in-thread, exactly like the
  // general route.
  const runInput = await prisma.runInput.create({
    data: {
      description: input.description,
      externalTicketId,
      payload: {
        channelId: input.channelId,
        kind: 'channel-task',
        repoId: repo.repoId,
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

  // Deterministic workflowId: one task run per thread (shared with the general
  // route so a re-delegate in the same thread is rejected, not clobbered).
  const workflowId = `chantask-${sanitizeIdPart(input.channelId)}-${sanitizeIdPart(input.threadTs)}`;

  const request: RepoWorkRequest = {
    channelId: input.channelId,
    description: input.description,
    externalTicketId,
    // Real repo: the SWE spec needs a workspace (implement → review → PR).
    repoId: repo.repoId,
    requestPayload: input.description,
    slackChannel: input.threadTs,
    workRequestId: runInput.id,
  };

  return { request, templateId, templateVersion, workflowId };
}
