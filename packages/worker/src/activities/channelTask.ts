import { prisma } from '@auto-swe/shared/db';
import {
  CHANNEL_TASK_TEMPLATE_NAME,
  channelTaskWorkflowId,
} from '@auto-swe/shared/lib/channelTask';
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
 * The template name (the stable `findFirst({ name, teamId: null })` lookup key)
 * comes from the shared, vitest-aliased `@auto-swe/shared/lib/channelTask` so it
 * can't drift from the seed in `syncBuiltins`.
 */

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
  /**
   * Gap D: ISO 8601 UTC timestamp to defer task execution. When it parses to a
   * valid FUTURE time, the result carries `runAt` and the caller launches a
   * `ChannelScheduledTaskWorkflow` wrapper; an invalid or past value is ignored
   * (the task runs immediately).
   */
  runAt?: string;
}

export interface CreateChannelTaskRunResult {
  /** Deterministic Temporal workflowId for the task run (one per thread). */
  workflowId: string;
  templateId: string;
  templateVersion: number;
  /** The fully-formed run request the child `RunnableWorkflow` consumes. */
  request: RepoWorkRequest;
  /**
   * Gap D: present only when `runAt` parsed to a valid future timestamp. When set,
   * the caller starts a `ChannelScheduledTaskWorkflow` (which sleeps until `runAt`)
   * under `workflowId`; otherwise it launches `RunnableWorkflow` immediately under
   * the same `workflowId`.
   */
  runAt?: string;
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
  // Sentinel `repoId: ''` — the Channel Task spec is repo-less (its agent node
  // needs no workspace).
  return buildChannelTaskRun(input, { repoId: '', templateId, templateVersion });
}

/**
 * Shared builder for both task routes: persist the channel-task `RunInput` (the
 * typed `slackChannelId`/`slackMessageTs` columns thread the terminal Slack
 * notification back to source; `payload.kind === 'channel-task'` routes finalize
 * to the channel budget + in-thread report) and assemble the `RepoWorkRequest`
 * the child `RunnableWorkflow` consumes. `repoId` is `''` for the repo-less
 * general route or a real connection id for the code route (also stamped onto the
 * payload for observability).
 */
async function buildChannelTaskRun(
  input: CreateChannelTaskRunInput,
  resolved: { templateId: string; templateVersion: number; repoId: string }
): Promise<CreateChannelTaskRunResult> {
  const { templateId, templateVersion, repoId } = resolved;
  const externalTicketId = `slack-${input.slackChannelId}-${input.threadTs}`;

  const runInput = await prisma.runInput.create({
    data: {
      // Code route: link the resolved git_repo Connection so `finalizeWorkflowRun`
      // can derive the org (connection → team → orgId) and bill `OrgMonthlyUsage` +
      // enforce the org budget cap, exactly like a normal work request. The general
      // route is repo-less, so `connectionId` stays null (no org path).
      ...(repoId ? { connectionId: repoId } : {}),
      description: input.description,
      externalTicketId,
      payload: {
        channelId: input.channelId,
        kind: 'channel-task',
        ...(repoId ? { repoId } : {}),
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

  // Deterministic workflowId: one task run per thread (regardless of route), so a
  // re-delegate in the same thread reuses (not clobbers) the in-flight run.
  const workflowId = channelTaskWorkflowId(input.channelId, input.threadTs);

  const request: RepoWorkRequest = {
    channelId: input.channelId,
    description: input.description,
    externalTicketId,
    repoId,
    requestPayload: input.description,
    slackChannel: input.threadTs,
    workRequestId: runInput.id,
  };

  // Gap D: only defer when `runAt` parses to a valid FUTURE timestamp. An invalid
  // (e.g. non-ISO model output) or past value is dropped so the task runs
  // immediately rather than silently mis-scheduling.
  return { request, runAt: validFutureRunAt(input.runAt), templateId, templateVersion, workflowId };
}

/**
 * Return `runAt` only when it parses to a valid timestamp strictly in the future;
 * otherwise `undefined` (run immediately). Centralised so both task routes treat a
 * garbled or past `runAt` identically.
 */
function validFutureRunAt(runAt: string | undefined): string | undefined {
  if (!runAt) {
    return undefined;
  }
  const ms = Date.parse(runAt);
  return Number.isFinite(ms) && ms > Date.now() ? runAt : undefined;
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
    // A hint that matches → use it. A hint that does NOT match → fall back to the
    // general route (return null) rather than silently opening a PR against an
    // unrelated repo. Only the no-hint case takes the single-repo default below.
    return match ? { repoId: match.id } : null;
  }

  // (b) No hint + exactly one repo → unambiguous default.
  if (repos.length === 1) {
    return { repoId: repos[0].id };
  }

  // (c) No hint + multiple repos → ambiguous; caller falls back to general.
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
  /** Gap D: ISO 8601 UTC timestamp to defer execution. Propagated to `buildChannelTaskRun`. */
  runAt?: string;
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
  // Real `repoId` so the SWE spec's implement → review → PR nodes have a workspace.
  return buildChannelTaskRun(input, { repoId: repo.repoId, templateId, templateVersion });
}
