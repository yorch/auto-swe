import type { Prisma } from '@auto-swe/shared';
import type { SettingResolveCtx } from '@auto-swe/shared/config';
import { snapshotPinnedSettings } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { AGENT_RUN_TEMPLATE_ORIGIN } from '@auto-swe/shared/lib/agentRun';
import { billedOrgId, currentYearMonth } from '@auto-swe/shared/lib/billing';
import { resolveIssueTrackerConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { isTrackerTicket, syncTrackerOnEvent } from '@auto-swe/shared/lib/trackerSync';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { migrateSpec, parseWorkflowSpec, SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import { Context } from '@temporalio/activity';
import { currentTemporalRunId } from '../lib/activityContext.js';
import { logError } from '../lib/activityLog.js';
import { backfillPinnedSettings } from '../lib/config/pinnedSettings.js';
import { type EndRunOutcome, endWorkflowRun } from '../lib/endRun.js';
import { recordRunFinalized } from '../lib/metrics.js';
import {
  snapshotAgentRuntimes,
  snapshotAgentVersions,
  snapshotSkillRevisions,
} from '../lib/runPins.js';
import {
  notifySlackRunComplete,
  notifySlackStepFailure,
  postSlackThreadMessage,
} from '../lib/slackNotify.js';
import { sumRunTraceUsage } from '../lib/traceTotals.js';
import { accrueChannelUsage } from './channelAssistant.js';
import {
  assertScheduledFireAuthorized,
  SCHEDULE_FIRE_ID_RE,
} from './scheduledFireAuthorization.js';

/**
 * Workflow run lifecycle activities. These live OUTSIDE the workflow file so
 * the interpreter (which runs in the V8 isolate) can call them through proxies.
 */

export interface CreateWorkflowRunInput {
  workflowId: string;
  templateId: string;
  templateVersion: number;
  workRequestId?: string;
  /// Who started this execution (see `RunRequest.launchedById`). Absent for a
  /// webhook or cron start, which then uses only the platform credential.
  launchedById?: string;
  /// Evals P2 canary: when set, this agent key is pinned to candidateVersion
  /// for the life of the run, and the run is tagged isCanary=true.
  canaryAgentKey?: string;
  canaryVersion?: number;
  /**
   * Set when this run is a child of an epic orchestrator. The gateway writes
   * the ledger row for the epic, not for its children, so the child's row is
   * created here — see {@link ensureEpicChildLedgerRow}.
   */
  parentWorkflowId?: string;
  /** The child's target connection, recorded on its ledger row. */
  repoId?: string | null;
}

/**
 * Give an epic child run its own `ActiveWorkflow` ledger row, linked to the
 * epic's work request, its repository and its parent.
 *
 * Every budget read and write keys on the workflow's own row
 * (`assertBudgetAvailable` / `recordLlmUsage`), and a child had none until a
 * template's first `updateDomainState` self-registered a bare one — so a
 * child's LLM spend before that was unmetered and uncapped, and after it sat on
 * a row nothing linked back to the epic's work request. The run finalizer then
 * found no ledger for the child and org usage never saw its spend.
 *
 * Idempotent (a Temporal retry, or a row `updateDomainState` already created,
 * just gets its links filled in) and it never touches `currentStatus` or the
 * counters on an existing row. The child inherits the epic's budget tier.
 */
async function ensureEpicChildLedgerRow(input: CreateWorkflowRunInput): Promise<void> {
  if (!input.parentWorkflowId) {
    return;
  }
  const parent = await prisma.activeWorkflow.findUnique({
    select: { budgetTier: true },
    where: { temporalWorkflowId: input.parentWorkflowId },
  });
  const links = {
    parentWorkflowId: input.parentWorkflowId,
    repoId: input.repoId ?? null,
    workRequestId: input.workRequestId ?? null,
  };
  await prisma.activeWorkflow.upsert({
    create: {
      ...links,
      budgetTier: parent?.budgetTier ?? 'STANDARD',
      currentStatus: 'STARTING',
      temporalWorkflowId: input.workflowId,
    },
    update: links,
    where: { temporalWorkflowId: input.workflowId },
  });
}

interface ScheduledFireAnchor {
  assignedBranch: string | null;
  budgetTier: string;
  repoId: string;
}

/** The schedule's anchor row, when this run is a fire of the schedule whose work request it carries. */
async function scheduledFireAnchor(
  input: CreateWorkflowRunInput
): Promise<ScheduledFireAnchor | null> {
  const match = input.workRequestId ? SCHEDULE_FIRE_ID_RE.exec(input.workflowId) : null;
  if (!match) {
    return null;
  }
  const anchor = await prisma.activeWorkflow.findUnique({
    select: { assignedBranch: true, budgetTier: true, repoId: true, workRequestId: true },
    where: { temporalWorkflowId: `sched-${match[1]}` },
  });
  if (!anchor?.repoId || anchor.workRequestId !== input.workRequestId) {
    return null;
  }
  return { ...anchor, repoId: anchor.repoId };
}

/**
 * Give a scheduled fire its own `ActiveWorkflow` ledger row, carrying the
 * schedule's repository, branch and budget tier.
 *
 * A fire is a run of the schedule's standing work request, which names no
 * connection, and the only ledger row it has is the schedule's anchor
 * (`sched-<id>`, never a real fire's id). The fire's spend accrues to a row
 * keyed by its own workflow id, which nothing created until a template's first
 * `updateDomainState` self-registered a bare one: no repository, so no
 * organization for the cap or for billing, no link to the work request, so the
 * finalizer billed the anchor's zero, and the default budget tier instead of
 * the schedule's. The returned repository goes on the run row as its
 * `connectionId`, so the cap guard, the in-flight count and `finalizeRun` all
 * reach the org through the run, as for an epic child.
 *
 * Written by `createWorkflowRun` only after the run row exists: a row written
 * ahead of it would sit in STARTING for ever if the run never came to be (the
 * reaper closes rows through runs), counted against the schedule creator's
 * concurrency cap. The repository is read earlier, by `scheduledFireAnchor`,
 * because the run row and the pinned settings need it. Idempotent, and never
 * touches `currentStatus` or the counters of an existing row.
 */
async function writeScheduledFireLedgerRow(
  input: CreateWorkflowRunInput,
  anchor: ScheduledFireAnchor
): Promise<void> {
  const links = { repoId: anchor.repoId, workRequestId: input.workRequestId ?? null };
  await prisma.activeWorkflow.upsert({
    create: {
      ...links,
      assignedBranch: anchor.assignedBranch,
      budgetTier: anchor.budgetTier,
      currentStatus: 'STARTING',
      temporalWorkflowId: input.workflowId,
    },
    update: links,
    where: { temporalWorkflowId: input.workflowId },
  });
}

/**
 * The refusal message when a run's repository points at a retired installation,
 * or null when it does not.
 *
 * Resolves the connection from the run's own `repoId` when it carries one (an
 * epic child), else through the work request. A run with neither, or whose
 * work request targets no connection, is not checked here — see the
 * Limitations in docs/repo-access-gating.md.
 */
async function installationRetiredForRun(
  input: Pick<CreateWorkflowRunInput, 'repoId' | 'workRequestId'>
): Promise<string | null> {
  const select = {
    installation: { select: { isActive: true } },
    organizationName: true,
    repoName: true,
  } as const;
  // An epic child names its own repository; its work request is the epic's,
  // which targets no single connection, so it must be checked by `repoId`.
  const connection = input.repoId
    ? await prisma.connection.findUnique({ select, where: { id: input.repoId } })
    : input.workRequestId
      ? ((
          await prisma.runInput.findUnique({
            select: { connection: { select } },
            where: { id: input.workRequestId },
          })
        )?.connection ?? null)
      : null;
  if (!connection?.installation || connection.installation.isActive) {
    return null;
  }
  return `the GitHub App installation for ${connection.organizationName}/${connection.repoName} has been retired; point the repository at a current installation before starting new work`;
}

/**
 * Creates the WorkflowRun row (used by RunnableWorkflow on first tick) and
 * returns its id + the spec snapshot. The spec is snapshotted on the row so
 * later edits to the template don't affect this run.
 */
export async function createWorkflowRun(
  input: CreateWorkflowRunInput
): Promise<
  | { runId: string; spec: WorkflowSpec; pinnedSettings?: Record<string, unknown> }
  | { error: string }
> {
  // Before anything else: has the installation this run's repository reaches
  // been retired?
  //
  // Checked here, inside the run's FIRST activity, rather than added as a new
  // activity call — the workflow's command sequence is replayed against
  // committed history fixtures, and an extra call would break every one of
  // them. An activity's own internals are free to change.
  //
  // The gateway refuses a retired installation at every launch path it owns,
  // but not every run starts at the gateway. A scheduled work request's
  // Temporal Schedule starts this workflow directly, so a schedule created
  // before retirement would otherwise keep pushing indefinitely — the standing
  // exemption for a cron fire is "there is no user to check", and this check
  // reads no user.
  //
  // It is also the only access condition a DEFERRED run re-reads. The channel
  // assistant's code task decides the requester's repository access when the
  // task is created, which for a task scheduled with `runAt` can be long before
  // it starts; nothing re-asks GitHub at the moment it does. Retirement is
  // re-read here because it is the one condition that takes no user.
  //
  // This is the run's start, so nothing already under way is affected, which is
  // what "retirement stops new work" was supposed to mean everywhere.
  // A scheduled fire re-takes the owner's launch decision (repository access,
  // org membership, the org's cap) before anything else, including the
  // retirement check below — which it subsumes for a fire, and whose returned
  // `{ error }` would wedge the schedule. Throws a non-retryable failure; a
  // no-op for every run that is not a scheduled fire.
  await assertScheduledFireAuthorized(input);

  const retired = await installationRetiredForRun(input);
  if (retired) {
    return { error: retired };
  }

  const version = await prisma.workflowTemplateVersion.findUnique({
    include: {
      template: {
        select: { estimatedHumanTimeSavedMinutes: true, origin: true, workspaceProvider: true },
      },
    },
    where: { templateId_version: { templateId: input.templateId, version: input.templateVersion } },
  });
  if (!version) {
    return { error: `template ${input.templateId}@v${input.templateVersion} not found` };
  }

  let spec: WorkflowSpec;
  try {
    const migrated = migrateSpec(version.spec, SPEC_SCHEMA_VERSION);
    spec = parseWorkflowSpec(migrated);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  // An epic child's ledger row must exist before its first LLM call, and this
  // is the run's first activity. Written only once the template has resolved
  // and parsed: every `{ error }` return above ends the run before it starts,
  // and a row written ahead of one would sit in STARTING forever, counted as
  // live work that nothing will ever finish.
  await ensureEpicChildLedgerRow(input);
  // A fire's ledger row is written after its run row below, not here: see
  // `writeScheduledFireLedgerRow`.
  const scheduledAnchor = await scheduledFireAnchor(input);
  const scheduledRepoId = scheduledAnchor?.repoId ?? null;

  // P1/WS3: snapshot the active GLOBAL Agent versions so this run resolves a
  // fixed Agent version regardless of later library edits. One row per key
  // today (version 1); kept as a { key: version } map for forward pins.
  const agentVersions = await snapshotAgentVersions();

  // Evals P2 canary: override the candidate agent's pinned version so
  // resolveAgent routes this run to the candidate arm.
  const { canaryAgentKey, canaryVersion } = input;
  const isCanary = !!(canaryAgentKey && canaryVersion != null);
  if (canaryAgentKey && canaryVersion != null) {
    agentVersions[canaryAgentKey] = canaryVersion;
  }

  // Freeze the registry settings marked `runPinned` for the life of this run,
  // alongside the agent-version pin. The interpreter runs in the V8 isolate and
  // cannot read the database, and a run that started under one transition
  // ceiling must finish under the same one or its replay history stops matching
  // its code — so these are resolved once, here, and carried forward.
  const settingsCtx = await runSettingsContext(input, scheduledRepoId);
  const pinnedSettings = await snapshotPinnedSettings(settingsCtx);

  // Skill text is a second input to every agent: freeze the revision of every
  // skill visible to this run so a mid-run edit cannot reach a retry or a replay.
  // An epic's children are runs of their own and pin at their own start, so an
  // edit between the epic's start and a child's reaches that child.
  const skillRevisions = await snapshotSkillRevisions(await skillTenantContext(input, settingsCtx));

  // Which loop drives each agent, frozen for the run as the agent versions are:
  // resolved in the same scope and under the same version pins its activities
  // use, so a later edit of an agent or a scoped override cannot switch it. An
  // agent run is the exception: `runAgentTask` resolves its one agent in a
  // narrower scope (no team or template override applies to a shared launch)
  // and pins it there, before its clone, so it pins at first use instead.
  const agentRuntimes =
    version.template?.origin === AGENT_RUN_TEMPLATE_ORIGIN
      ? undefined
      : await snapshotAgentRuntimes({ ...settingsCtx, agentVersions });

  // Upsert by workflowId — re-runs of a Temporal workflow execution with the
  // same workflowId should not create duplicate rows. `update: {}` preserves the
  // original spec, agentVersions and pinnedSettings snapshots across Temporal
  // retries.
  //
  // The launcher and Temporal run id are written on create only, for the same
  // reason. If the workflow id was reused by a later execution, this row still
  // names the earlier one's run id, so `currentRunLauncherId` will not match it
  // and the later execution gets no user credential — never the earlier
  // launcher's.
  const run = await prisma.workflowRun.upsert({
    create: {
      agentVersions,
      ...(agentRuntimes ? { agentRuntimes: agentRuntimes as Prisma.InputJsonObject } : {}),
      // An epic child's own repository. Its work request is the epic's and
      // spans every repository, so run visibility reads this instead — a member
      // of one of the epic's teams reaches that team's child, not all of them.
      ...(input.parentWorkflowId && input.repoId ? { connectionId: input.repoId } : {}),
      // A scheduled fire's standing work request names no connection either.
      ...(scheduledRepoId ? { connectionId: scheduledRepoId } : {}),
      estimatedHumanTimeSaved: version.template?.estimatedHumanTimeSavedMinutes ?? null,
      isCanary,
      launchedById: input.launchedById ?? null,
      outcomeDomain: version.template?.workspaceProvider ?? null,
      pinnedSettings: pinnedSettings as Prisma.InputJsonObject,
      skillRevisions,
      specSnapshot: spec as unknown as object,
      status: 'RUNNING',
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      temporalRunId: currentTemporalRunId(),
      workflowId: input.workflowId,
      workRequestId: input.workRequestId,
    },
    update: {},
    where: { workflowId: input.workflowId },
  });

  // The ledger row only has to exist before the run's first LLM call, which is
  // after this activity returns.
  if (scheduledAnchor) {
    await writeScheduledFireLedgerRow(input, scheduledAnchor);
  }

  // Read the pin back off the row rather than trusting the value just computed:
  // on a Temporal retry `update: {}` keeps the *original* snapshot, and the run
  // must keep using that one. A row that pre-dates the column, or a run-pinned
  // setting, gets the missing keys added at their value now.
  const persisted = await backfillPinnedSettings(run.id, run.pinnedSettings, pinnedSettings);
  if (!persisted) {
    // Retryable: the row kept changing underneath; the next attempt reads it afresh.
    throw new Error(`createWorkflowRun: could not backfill pinned settings on run ${run.id}`);
  }

  // Always return the spec actually stored on the row. On a Temporal retry the
  // row may already exist (update: {}), and returning the freshly-parsed spec
  // from `version.spec` would make the workflow see a different snapshot than
  // the history recorded.
  return {
    pinnedSettings: persisted,
    runId: run.id,
    spec: (run.specSnapshot as unknown as WorkflowSpec) ?? spec,
  };
}

/// The tenant whose skills a run can see. Normally the settings context's team and
/// org. A repo-less channel task has neither (no connection, no ledger repo), so
/// fall back to the tenant of the Slack channel the request came from: the same
/// channel row the channel's own activities scope to. Deliberately not folded into
/// `runSettingsContext`: that one must keep matching `currentRequestContext()`.
async function skillTenantContext(
  input: CreateWorkflowRunInput,
  settingsCtx: SettingResolveCtx
): Promise<SettingResolveCtx> {
  if (settingsCtx.teamId || settingsCtx.orgId || !input.workRequestId) {
    return settingsCtx;
  }
  const request = await prisma.runInput.findUnique({
    select: { slackChannelId: true },
    where: { id: input.workRequestId },
  });
  if (!request?.slackChannelId) {
    return settingsCtx;
  }
  const channel = await prisma.slackChannel.findFirst({
    select: { orgId: true, teamId: true },
    where: { slackChannelId: request.slackChannelId },
  });
  return channel
    ? { ...settingsCtx, orgId: channel.orgId ?? undefined, teamId: channel.teamId ?? undefined }
    : settingsCtx;
}

/// Scope context for the run's pinned-settings snapshot. The template comes from
/// the input; team and org have to be derived, and they must land on the SAME
/// tenant `currentRequestContext()` resolves for this run's activities — a
/// snapshot pinned at GLOBAL while every other setting resolves at TEAM is worse
/// than no pin at all.
///
/// Two sources, because the launch paths disagree: `POST /work-requests` sets
/// `RunInput.connectionId`, while the Slack slash-command and scheduled-request
/// paths leave it null and carry the repo on `ActiveWorkflow.repoId` instead.
/// `currentRequestContext()` reads the latter, so this reads both.
async function runSettingsContext(
  input: CreateWorkflowRunInput,
  scheduledRepoId: string | null = null
): Promise<SettingResolveCtx> {
  const ctx: SettingResolveCtx = { workflowTemplateId: input.templateId };

  const [request, active, fireRepo] = await Promise.all([
    input.workRequestId
      ? prisma.runInput.findUnique({
          select: { connection: { select: { team: { select: { orgId: true } }, teamId: true } } },
          where: { id: input.workRequestId },
        })
      : null,
    prisma.activeWorkflow.findFirst({
      select: { repository: { select: { team: { select: { orgId: true } }, teamId: true } } },
      where: { temporalWorkflowId: input.workflowId },
    }),
    // A scheduled fire's own ledger row is written after the settings are
    // pinned, so its repository comes from the schedule's anchor instead.
    scheduledRepoId
      ? prisma.connection.findUnique({
          select: { team: { select: { orgId: true } }, teamId: true },
          where: { id: scheduledRepoId },
        })
      : null,
  ]);

  const team = request?.connection ?? active?.repository ?? fireRepo;
  ctx.teamId = team?.teamId ?? undefined;
  ctx.orgId = team?.team?.orgId ?? undefined;
  return ctx;
}

export interface RecordStepInput {
  runId: string;
  nodeId: string;
  status: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'SKIPPED';
  inputs?: unknown;
  outputs?: unknown;
  error?: string;
  attempt?: number;
}

export async function recordWorkflowStep(input: RecordStepInput): Promise<void> {
  const now = new Date();
  const attempt = input.attempt ?? 1;

  // Temporal can retry an activity within the same attempt number under some
  // failure modes; the unique constraint on (run_id, node_id, attempt) plus an
  // upsert makes step recording idempotent.
  await prisma.workflowStep.upsert({
    create: {
      attempt,
      endedAt: input.status === 'RUNNING' || input.status === 'PENDING' ? null : now,
      error: input.error,
      inputs: input.inputs as object | undefined,
      nodeId: input.nodeId,
      outputs: input.outputs as object | undefined,
      runId: input.runId,
      startedAt: now,
      status: input.status,
    },
    update: {
      endedAt: input.status === 'RUNNING' || input.status === 'PENDING' ? null : now,
      error: input.error,
      inputs: input.inputs as object | undefined,
      outputs: input.outputs as object | undefined,
      status: input.status,
    },
    where: { runId_nodeId_attempt: { attempt, nodeId: input.nodeId, runId: input.runId } },
  });

  // Phase-7: best-effort Slack notification on terminal FAILED records. The
  // interpreter records the FAILED row only after onFail retry budget is
  // exhausted (or for warn-mode it records and continues), so we won't spam
  // the channel on every mid-retry attempt. Guard on the Temporal activity
  // attempt as well, so a notification that succeeds but is followed by an
  // activity failure is not re-sent on retry.
  if (input.status === 'FAILED' && Context.current().info.attempt === 1) {
    await notifySlackStepFailure({
      attempt: input.attempt ?? 1,
      error: input.error,
      nodeId: input.nodeId,
      runId: input.runId,
    });
  }
}

export async function finalizeWorkflowRun(
  runId: string,
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED',
  contextSnapshot?: unknown
): Promise<void> {
  await finalizeRun(runId, status, contextSnapshot, 'worker');
}

/**
 * The finalization core: ends the run, bills its org, and fires the terminal
 * side effects, exactly once however many callers race (`endWorkflowRun`
 * guards the write). `source` labels `workflow_runs_finalized_total`; the run
 * reaper reaches the same core as the workflow's own finalize step, so a run it
 * ends is billed identically. `notify: false` suppresses the user-facing side
 * effects (Slack run-complete notice, in-thread channel report, tracker sync):
 * the reaper passes it for a run whose execution closed long ago or no longer
 * exists, because a first sweep over history would otherwise post every orphan at
 * once, possibly against tickets a later run already completed. A run that
 * ended minutes ago still notifies. Resolves true when this call ended the run,
 * false when another attempt already had.
 */
export async function finalizeRun(
  runId: string,
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED',
  contextSnapshot: unknown,
  source: 'worker' | 'reaper',
  // User-facing notices (Slack, in-thread report, tracker sync). The reaper
  // turns them off only for a run that ended long ago or whose execution is gone.
  notify = true
): Promise<boolean> {
  // Phase-8 denormalize the run's cost + token totals onto workflow_runs at finalize
  // time. Read the workRequest → activeWorkflows join once, sum, then write back.
  const run = await prisma.workflowRun.findUnique({
    select: {
      connection: { select: { team: { select: { orgId: true } } } },
      connectionId: true,
      endedAt: true,
      workflowId: true,
      workRequest: {
        select: {
          activeWorkflows: {
            select: {
              costUsdAccrued: true,
              temporalWorkflowId: true,
              tokensInputUsed: true,
              tokensOutputUsed: true,
            },
          },
          connection: {
            select: { team: { select: { orgId: true } } },
          },
          connectionId: true,
          externalTicketId: true,
          // Channel assistant (Phase A): a channel-launched task run carries its
          // origin in `payload.channelId` + the Slack thread coordinates. Used
          // below to accrue cost to ChannelMonthlyUsage + report the result back.
          payload: true,
          slackChannelId: true,
          slackMessageTs: true,
          ticketIsSynthetic: true,
        },
      },
    },
    where: { id: runId },
  });
  // The run's ledger is its OWN row when it has one. An epic's work request
  // carries the epic's row plus one per child, so summing every row under the
  // work request would bill each child for the whole epic — and add the same
  // spend to org usage once per child. Falls back to every row under the work
  // request when none matches (the historical behaviour).
  const requestWorkflows = run?.workRequest?.activeWorkflows ?? [];
  const ownWorkflows = requestWorkflows.filter((aw) => aw.temporalWorkflowId === run?.workflowId);
  const workflows = ownWorkflows.length > 0 ? ownWorkflows : requestWorkflows;
  let costUsdAccrued = workflows.reduce((sum, aw) => sum + aw.costUsdAccrued, 0);
  let tokensInputTotal = workflows.reduce((sum, aw) => sum + (aw.tokensInputUsed ?? 0n), 0n);
  let tokensOutputTotal = workflows.reduce((sum, aw) => sum + (aw.tokensOutputUsed ?? 0n), 0n);

  // Phase-5 metadata: outcome type, human step presence, and autonomy.
  const [outcomeRefs, humanStepCount, autonomyDecisions, errorEvals] = await Promise.all([
    prisma.workflowOutcomeReference.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { result: true },
      where: { runId },
    }),
    prisma.workflowHumanStep.count({ where: { runId } }),
    prisma.autonomyDecision.findMany({
      select: { event: true, payload: true },
      where: { runId },
    }),
    prisma.evalResult.findMany({
      select: { source: true },
      where: { passed: false, runId },
    }),
  ]);

  const firstConnectionType =
    outcomeRefs &&
    typeof outcomeRefs.result === 'object' &&
    outcomeRefs.result !== null &&
    'connectionType' in outcomeRefs.result
      ? String((outcomeRefs.result as { connectionType?: unknown }).connectionType)
      : undefined;
  const hadHumanStep = humanStepCount > 0;
  const wasAutonomous =
    !hadHumanStep &&
    autonomyDecisions.length > 0 &&
    autonomyDecisions.every((d) => {
      if (d.event !== 'publish') {
        return true;
      }
      const decision =
        typeof d.payload === 'object' && d.payload !== null && 'decision' in d.payload
          ? String((d.payload as { decision?: unknown }).decision)
          : undefined;
      return decision === 'auto';
    });

  const ERROR_EVAL_SOURCES = new Set(['GATE', 'ASSERT', 'PII', 'POLICY', 'REVIEW', 'HUMAN_AUDIT']);
  const hasError = errorEvals.some((e) => ERROR_EVAL_SOURCES.has(e.source));

  // Repo-less runs (e.g. a general Channel Task) have no ActiveWorkflow ledger
  // row, so `recordLlmUsage` never accrued run-level cost/tokens there — the only
  // record of the spend is the run's AgentTrace rows. Sum those so `/runs` shows
  // the real cost instead of $0/0 tokens. (SWE runs always have an ActiveWorkflow,
  // so this branch is skipped for them.) The summed cost is reused below for the
  // channel-budget ledger so `finalizeChannelTaskRun` doesn't re-aggregate.
  let channelTraceCostUsd: number | undefined;
  if (workflows.length === 0) {
    const traceTotals = await sumRunTraceUsage(runId);
    costUsdAccrued = traceTotals.costUsd;
    tokensInputTotal = traceTotals.inputTokens;
    tokensOutputTotal = traceTotals.outputTokens;
    channelTraceCostUsd = costUsdAccrued;
  }

  // P5: aggregate cost into OrgMonthlyUsage with Prisma's increment operator
  // (race-safe across concurrent finalizations). finalizeWorkflowRun is a Temporal
  // activity that can be retried, so we gate the write on the atomic
  // `updateMany` count instead of a stale pre-read. The denormalize update + org
  // upsert run in one transaction when an org is present. That makes the pair
  // atomic: a retry after commit sees endedAt set and count === 0; a retry after
  // rollback re-reads endedAt null and re-does both. runsCompleted counts only
  // SUCCESS; cost/tokens accrue for every terminal status (real spend).
  if (run?.endedAt != null) {
    return false;
  }

  // An epic's work request targets no single connection, so an epic child
  // reaches its org through its own run's connection; a run with no connection
  // anywhere, through its own ledger row's repository. The order
  // `readOrgMonthSpend` and `resolveBilledOrg` (the mid-run cap) also use, so a
  // run is billed to the org the cap counted it under.
  const placedByConnection = !!(run?.workRequest?.connectionId || run?.connectionId);
  let ledgerOrgId: string | null = null;
  if (!placedByConnection && run?.workflowId) {
    // The ledger row is read by workflow id whether or not it is linked to the
    // work request, as the cap guard reads it, so both find the same org.
    const ledger = await prisma.activeWorkflow.findFirst({
      select: { repository: { select: { team: { select: { orgId: true } } } } },
      where: { temporalWorkflowId: run.workflowId },
    });
    ledgerOrgId = ledger?.repository?.team?.orgId ?? null;
  }
  const orgId = billedOrgId({
    ledgerOrgId,
    requestConnectionId: run?.workRequest?.connectionId,
    requestOrgId: run?.workRequest?.connection?.team?.orgId,
    runConnectionId: run?.connectionId,
    runOrgId: run?.connection?.team?.orgId,
  });

  // A run the dashboard cancelled ends CANCELLED whatever the workflow reports
  // (`endWorkflowRun`), and everything below follows the status it ended with.
  const endedStatus = (o: EndRunOutcome) => (o === 'cancelled' ? 'CANCELLED' : status);
  // Write the terminal status back to the ActiveWorkflow row. Templates only
  // advance currentStatus through happy-path states, so without this a
  // failed/timed-out/cancelled run leaves its row "active" forever and the
  // dashboard KPIs drift. SUCCESS maps to COMPLETED (a no-op on specs that
  // already set it). SKIPPED, a terminate node ending the run without work, has
  // no ledger value of its own and maps to COMPLETED too: the execution ended
  // as designed, and a row left non-terminal would block a retry or a scheduled
  // fire of the request for ever. The run row keeps SKIPPED.
  const activeWorkflowStatus = (s: typeof status) =>
    s === 'SUCCESS' || s === 'SKIPPED' ? 'COMPLETED' : s;

  const terminalUpdate = {
    contextSnapshot: contextSnapshot as object | undefined,
    costUsdAccrued,
    endedAt: new Date(),
    hadHumanStep,
    hasError,
    outcomeType: firstConnectionType ?? null,
    status,
    tokensInputTotal,
    tokensOutputTotal,
    wasAutonomous,
  };

  let outcome: EndRunOutcome;
  if (orgId) {
    // Always the month of finalization, whoever finalizes: the cap counts an
    // unfinalized run's spend in the current month whenever it started
    // (`orgMonthSpend`), so billing it anywhere else would move spend out of the
    // figure the cap reads. A run that crosses a month boundary, or is reaped
    // late, lands wholly in the month it ends in; splitting it would need
    // per-call timestamps on the ledger.
    const yearMonth = currentYearMonth();
    outcome = await prisma.$transaction(async (tx) => {
      // CLAUDE.md §7 exception: a transaction-scoped advisory lock serialises
      // concurrent finalisations for one org; Prisma has no API for it.
      // `$executeRaw`, not `$queryRaw`: the lock function returns void, which
      // the Prisma 7 driver adapter cannot deserialise as a result column.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${orgId}, 0))
      `;
      const ended = await endWorkflowRun(tx, runId, terminalUpdate);
      if (ended === 'alreadyEnded') {
        return ended; // already finalized by a concurrent attempt
      }
      const endedWith = endedStatus(ended);
      const terminalStatus = activeWorkflowStatus(endedWith);
      if (terminalStatus && run?.workflowId) {
        await tx.activeWorkflow.updateMany({
          data: { currentStatus: terminalStatus },
          where: { temporalWorkflowId: run.workflowId },
        });
      }
      const runsIncrement = endedWith === 'SUCCESS' ? 1 : 0;
      await tx.orgMonthlyUsage.upsert({
        create: {
          costUsdAccrued,
          orgId,
          runsCompleted: runsIncrement,
          tokensInput: tokensInputTotal,
          tokensOutput: tokensOutputTotal,
          yearMonth,
        },
        update: {
          costUsdAccrued: { increment: costUsdAccrued },
          runsCompleted: { increment: runsIncrement },
          tokensInput: { increment: tokensInputTotal },
          tokensOutput: { increment: tokensOutputTotal },
        },
        where: { orgId_yearMonth: { orgId, yearMonth } },
      });
      return ended;
    });
  } else {
    outcome = await prisma.$transaction(async (tx) => {
      const ended = await endWorkflowRun(tx, runId, terminalUpdate);
      if (ended === 'alreadyEnded') {
        return ended; // already finalized by a concurrent attempt
      }
      const terminalStatus = activeWorkflowStatus(endedStatus(ended));
      if (terminalStatus && run?.workflowId) {
        await tx.activeWorkflow.updateMany({
          data: { currentStatus: terminalStatus },
          where: { temporalWorkflowId: run.workflowId },
        });
      }
      return ended;
    });
  }

  if (outcome === 'alreadyEnded') {
    return false;
  }
  // Counted only by the attempt that finalized, so a retried activity cannot
  // double it — and not for a run the dashboard cancelled, which the cancel
  // route already counted.
  if (outcome === 'ended') {
    recordRunFinalized(status, source);
  }
  const finalStatus = endedStatus(outcome);

  // The side effects below (Slack notifications + channel task finalization +
  // tracker sync) are non-idempotent. Only fire them when we actually finalized
  // the run above.
  // Channel-task runs own their terminal in-thread report (finalizeChannelTaskRun
  // below — opt-in-independent, exactly one message). Skip the generic
  // run-complete notification for them: the CODE route resolves a real
  // team-via-connection, so notifySlackRunComplete would otherwise post a SECOND,
  // redundant completion message into the SAME thread (double-post). For ordinary
  // SWE runs this still fires (gated on the team's `slackNotifySuccess` opt-in).
  const channelTaskPayload = readChannelTaskPayload(run?.workRequest?.payload);
  if (!channelTaskPayload && notify) {
    await notifySlackRunComplete({ runId, status: finalStatus });
  }

  // Channel assistant (Phase A): for a channel-launched task run, (a) accrue its
  // cost to the channel's monthly budget (from the run's AgentTrace rows; for the
  // code route that is a SEPARATE ledger from the OrgMonthlyUsage the connection
  // path already billed — different tables, not a double-count) and (b) report
  // the result back into the originating thread REGARDLESS of the team success
  // opt-in (these runs are user-requested in-thread). Both best-effort. We pass the
  // already-summed trace cost (general route) + the in-hand contextSnapshot so it
  // re-reads neither.
  await finalizeChannelTaskRun(runId, finalStatus, run?.workRequest, channelTaskPayload, {
    contextSnapshot,
    report: notify,
    traceCostUsd: channelTraceCostUsd,
  });

  // Best-effort tracker sync on workflow terminal status.
  const externalTicketId = run?.workRequest?.externalTicketId;
  if (
    notify &&
    externalTicketId &&
    isTrackerTicket(run?.workRequest) &&
    (finalStatus === 'SUCCESS' || finalStatus === 'FAILED' || finalStatus === 'TIMED_OUT')
  ) {
    const trackerConfig = await resolveIssueTrackerConfig();
    await syncTrackerOnEvent(
      finalStatus === 'SUCCESS'
        ? { issueId: externalTicketId, type: 'workflow_completed' }
        : {
            issueId: externalTicketId,
            summary: `Workflow ended with status: ${finalStatus}`,
            type: 'workflow_failed',
          },
      trackerConfig
    ).catch(() => null);
  }
  return true;
}

/** Shape of the `payload` we stamp onto a channel-task RunInput. */
interface ChannelTaskPayload {
  kind?: string;
  channelId?: string;
  title?: string;
}

/**
 * Narrow a RunInput `payload` to a channel-task payload — returns it only when
 * `kind === 'channel-task'` and a `channelId` is present, else `null`. Shared by
 * `finalizeWorkflowRun` (to suppress the duplicate run-complete notification) and
 * `finalizeChannelTaskRun` so the channel-task discriminant is parsed once.
 */
function readChannelTaskPayload(payload: unknown): ChannelTaskPayload | null {
  const p = (payload ?? null) as ChannelTaskPayload | null;
  if (p?.kind !== 'channel-task' || !p.channelId) {
    return null;
  }
  return p;
}

/** Max chars of the agent's result text posted back to the thread. */
const CHANNEL_TASK_RESULT_MAX = 3500;

/**
 * Channel assistant (Phase A): finalize the channel-specific side effects of a
 * channel-launched task run. No-ops for any non-channel run (the common SWE
 * path). Both steps are best-effort + wrapped so they never fail the finalize.
 *
 *  1. Accrue the run's total cost to `ChannelMonthlyUsage` (the per-channel
 *     budget ledger). The cost lives in the run's AgentTrace rows — channel
 *     tasks have no ActiveWorkflow, so `recordLlmUsage` never wrote a run-level
 *     ledger row, and there's no connection→org link, so OrgMonthlyUsage was not
 *     touched either (no double-count).
 *  2. Post the run's result back into the originating Slack thread regardless of
 *     `Team.slackNotifySuccess` — these runs are explicitly user-requested
 *     in-thread, so they always report.
 */
async function finalizeChannelTaskRun(
  runId: string,
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED',
  workRequest:
    | {
        slackChannelId: string | null;
        slackMessageTs: string | null;
      }
    | null
    | undefined,
  payload: ChannelTaskPayload | null,
  ctx: { contextSnapshot: unknown; report: boolean; traceCostUsd: number | undefined }
): Promise<void> {
  // `payload` is the already-narrowed channel-task discriminant from
  // `finalizeWorkflowRun` (`readChannelTaskPayload`). Null → not a channel task.
  if (!payload?.channelId) {
    return;
  }
  const channelId = payload.channelId;

  // 1. Accrue cost to the channel ledger. `finalizeWorkflowRun` already summed the
  //    run's AgentTrace cost for the repo-less general route (passed as
  //    `traceCostUsd`); reuse it rather than re-aggregating. The code route bills
  //    OrgMonthlyUsage via its connection path, so here we sum its AgentTrace cost
  //    once for the SEPARATE channel ledger (a different table, not a double-count).
  try {
    const costUsd =
      ctx.traceCostUsd ??
      (
        await runUnscoped('scoped by the run being finalized', ['AgentTrace'], () =>
          prisma.agentTrace.aggregate({ _sum: { costUsd: true }, where: { runId } })
        )
      )._sum.costUsd ??
      0;
    await accrueChannelUsage(channelId, costUsd);
  } catch (err) {
    logError(`[finalizeChannelTaskRun] failed to accrue channel usage for ${channelId}:`, {
      channelId,
      err: err instanceof Error ? err.message : err,
    });
  }

  // 2. Report the result back into the originating thread (opt-in-independent).
  //    Not for a run the reaper ended: the accrual above is billing, this is a
  //    notice the user would meet long after the fact.
  if (!ctx.report) {
    return;
  }
  const slackChannelId = workRequest?.slackChannelId;
  const threadTs = workRequest?.slackMessageTs;
  if (!slackChannelId || !threadTs) {
    return;
  }
  try {
    const reason = status === 'FAILED' ? await priceRefusalReason(runId) : undefined;
    const text = buildChannelTaskResultText(ctx.contextSnapshot, status, payload.title, reason);
    await postSlackThreadMessage(slackChannelId, threadTs, text);
  } catch (err) {
    // Best-effort: a Slack failure must not fail the finalize.
    logError(`[finalizeChannelTaskRun] failed to post result for channel ${channelId}:`, {
      channelId,
      err: err instanceof Error ? err.message : err,
    });
  }
}

const PRICE_REFUSAL_PREFIXES = ['MODEL_UNPRICED: ', 'MODEL_PRICE_UNAVAILABLE: '];

/**
 * The reason a task failed when the cause was a refused model call (no price
 * under the channel's USD cap), read from the failed step the interpreter
 * recorded as `<TYPE>: <message>`; otherwise nothing. Best-effort: a lookup
 * failure leaves the generic line.
 */
async function priceRefusalReason(runId: string): Promise<string | undefined> {
  try {
    const step = await prisma.workflowStep.findFirst({
      orderBy: { endedAt: 'desc' },
      select: { error: true },
      where: {
        OR: PRICE_REFUSAL_PREFIXES.map((p) => ({ error: { startsWith: p } })),
        runId,
        status: 'FAILED',
      },
    });
    const error = step?.error;
    const prefix = error ? PRICE_REFUSAL_PREFIXES.find((p) => error.startsWith(p)) : undefined;
    return error && prefix ? error.slice(prefix.length) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the in-thread result message for a finished channel task. On SUCCESS we
 * surface the general-route agent's text result from the in-hand `contextSnapshot`.
 * The Channel Task spec has two answer-producing shapes: the decompose path ends at
 * the `composite` step node (`runChannelSubtasks`), the single-agent path at `task` —
 * read `composite` first, falling back to `task`. When neither is present — the code
 * route (a SWE run with different node ids) or an empty answer — we post a plain
 * completion line. The code route's PR link is already threaded into the conversation
 * by `notifySlackPrReady` at PR-open time, so we don't re-surface it here. Non-success
 * statuses get a short failure note. Truncated to {@link CHANNEL_TASK_RESULT_MAX} chars.
 */
export function buildChannelTaskResultText(
  contextSnapshot: unknown,
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED',
  title: string | undefined,
  reason?: string
): string {
  const titleLine = title ? ` *${title}*` : '';
  if (status !== 'SUCCESS') {
    const why = reason ? ` ${reason}` : '';
    return `:rotating_light: Task${titleLine} finished with status *${status}*.${why}`;
  }

  const snapshot = (contextSnapshot ?? null) as {
    nodes?: {
      composite?: { output?: { text?: unknown } };
      task?: { output?: { text?: unknown } };
    };
  } | null;
  const out = snapshot?.nodes?.composite?.output?.text ?? snapshot?.nodes?.task?.output?.text;
  const resultText = typeof out === 'string' ? out.trim() : '';

  if (!resultText) {
    return `:white_check_mark: Task${titleLine} is done.`;
  }
  const body =
    resultText.length > CHANNEL_TASK_RESULT_MAX
      ? `${resultText.slice(0, CHANNEL_TASK_RESULT_MAX)}…`
      : resultText;
  return `:white_check_mark: Task${titleLine} is done:\n\n${body}`;
}

/**
 * Resolve which workflow template a repo's work should run against. Prefers
 * the repo's team default; falls back to the global (teamId IS NULL) default.
 * Used by the epic orchestrator to start child workflows per repo. Throws if
 * no template is configured — workflows can't run without one.
 */
export async function resolveTemplateForRepo(
  repoId: string
): Promise<{ templateId: string; templateVersion: number }> {
  const repo = await prisma.connection.findUniqueOrThrow({
    select: { teamId: true },
    where: { id: repoId },
  });

  const teamTpl = await prisma.workflowTemplate.findFirst({
    orderBy: [{ activeVersion: 'desc' }, { updatedAt: 'desc' }],
    where: { isDefault: true, status: 'ACTIVE', teamId: repo.teamId },
  });
  const tpl =
    teamTpl ??
    (await prisma.workflowTemplate.findFirst({
      orderBy: [{ activeVersion: 'desc' }, { updatedAt: 'desc' }],
      where: { isDefault: true, status: 'ACTIVE', teamId: null },
    }));

  if (!tpl?.activeVersion) {
    throw new Error(
      `no active default workflow template for repo ${repoId} (team ${repo.teamId}). Run \`yarn db:seed\`.`
    );
  }
  return { templateId: tpl.id, templateVersion: tpl.activeVersion };
}
