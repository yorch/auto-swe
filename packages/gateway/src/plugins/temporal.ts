import { resolveTemporalAddress } from '@auto-swe/shared/lib/systemConfig';
import type {
  ChannelAssistantTurnInput,
  ConsolidateLessonsInput,
  EpicRequest,
  RepoWorkRequest,
  ScheduledConsolidationInput,
  ScheduledEvalInput,
  ScheduledRevalidationInput,
} from '@auto-swe/shared/types/workflow';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import {
  Client,
  Connection,
  ScheduleClient,
  type ScheduleHandle,
  ScheduleNotFoundError,
  type ScheduleOptionsAction,
  ScheduleOverlapPolicy,
  WorkflowIdReusePolicy,
} from '@temporalio/client';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

export const CONSOLIDATION_SCHEDULE_ID = 'auto-swe-lesson-consolidation';
export const EVAL_SCHEDULE_ID = 'auto-swe-eval-regression';
export const REVALIDATION_SCHEDULE_ID = 'auto-swe-eval-revalidation';
export const REPO_DEPENDENCY_SCAN_SCHEDULE_ID = 'auto-swe-repo-dependency-scan';
export const REPO_ACCESS_SYNC_SCHEDULE_ID = 'auto-swe-repo-access-sync';

/** Temporal Schedule ID for a ScheduledWorkRequest row. */
export function workRequestScheduleId(scheduleRowId: string): string {
  return `auto-swe-scheduled-wr-${scheduleRowId}`;
}

/** Temporal Schedule ID for a SlackChannel's ambient-mode digest (channel assistant P3). */
export function channelAmbientScheduleId(channelId: string): string {
  return `auto-swe-channel-ambient-${channelId}`;
}

/** Temporal Schedule ID for a SlackChannel's reactive-interjection poll (Gap A). */
export function channelReactiveScheduleId(channelId: string): string {
  return `auto-swe-channel-reactive-${channelId}`;
}

/**
 * Everything the recurring-work-request Schedule needs to start
 * RunnableWorkflow. Args are STATIC per Temporal's schedule model — template
 * resolution and the standing workRequestId are snapshotted at save time by
 * the gateway route, not at fire time.
 */
export interface WorkRequestScheduleInput {
  scheduleRowId: string;
  cronExpression: string;
  paused: boolean;
  templateId: string;
  templateVersion: number;
  request: RepoWorkRequest;
}

export interface WorkRequestScheduleStatus {
  exists: boolean;
  paused: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface ChannelAmbientScheduleInput {
  channelId: string;
  cronExpression: string;
}

export interface ChannelAmbientScheduleStatus {
  exists: boolean;
  paused: boolean;
  nextRunAt: string | null;
}

export interface ChannelReactiveScheduleInput {
  channelId: string;
  cronExpression: string;
}

export interface ConsolidationScheduleConfig {
  enabled: boolean;
  cronExpression: string;
  minClusterSize: number;
  similarityThreshold: number;
}

export interface ConsolidationScheduleStatus {
  exists: boolean;
  paused: boolean;
  nextRunAt: string | null;
}

export interface EvalScheduleConfig {
  enabled: boolean;
  cronExpression: string;
  datasetSlug: string;
  candidateRef: string;
  baselineRef: string;
}

export interface EvalScheduleStatus {
  exists: boolean;
  paused: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

/** Input to start an async NL-generation job. */
export interface WorkflowAuthorJobInput {
  prompt: string;
  teamId: string | null;
  name?: string;
  createdById?: string | null;
}

/** Poll result for an async NL-generation job. */
export type WorkflowAuthorJobStatus =
  | { status: 'running'; phase?: string }
  | {
      status: 'done';
      result: { templateId: string; name: string; summary: string; attempts: number };
    }
  | { status: 'failed'; code: string; message: string };

export interface RevalidationScheduleConfig {
  enabled: boolean;
  cronExpression: string;
  datasetSlug?: string | null;
}

export interface RevalidationScheduleStatus {
  exists: boolean;
  paused: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

/**
 * Repo dependency graph — the periodic re-scan that catches manifest drift and
 * repos newly onboarded since the last sweep (an unresolved suggestion becomes a
 * real edge once its repo exists). The workflow takes no arguments: it fans out
 * over every active git_repo itself.
 */
export interface RepoDependencyScanScheduleConfig {
  enabled: boolean;
  cronExpression: string;
}

/**
 * The sweep that refreshes cached GitHub permission answers. Like the
 * dependency scan, the workflow discovers its own repository set, so the
 * schedule carries no arguments.
 */
export interface RepoAccessSyncScheduleConfig {
  enabled: boolean;
  cronExpression: string;
}

export interface RepoDependencyScanScheduleStatus {
  exists: boolean;
  paused: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    temporal: {
      startRunnableWorkflow: (
        workflowId: string,
        input: { templateId: string; templateVersion: number; request: RepoWorkRequest }
      ) => Promise<void>;
      startEpicWorkflow: (workflowId: string, request: EpicRequest) => Promise<void>;
      /**
       * Generate a WorkflowSpec from a natural-language description. Unlike the
       * other helpers this is request/response: it starts WorkflowAuthorWorkflow
       * and AWAITS the result (the generate→validate→repair loop runs in the
       * worker, where models bind).
       */
      generateWorkflowSpec: (
        workflowId: string,
        input: {
          prompt: string;
          teamId?: string | null;
          allowShell?: boolean;
          /** When set, refine this spec instead of generating from scratch. */
          baseSpec?: WorkflowSpec;
        }
      ) => Promise<{ spec: WorkflowSpec; summary: string; attempts: number }>;
      /** Explain a WorkflowSpec in plain language (request/response). */
      explainWorkflowSpec: (
        workflowId: string,
        input: { spec: WorkflowSpec; teamId?: string | null }
      ) => Promise<{ explanation: string }>;
      /** Start an async NL-generation job (does NOT await the result). */
      startWorkflowAuthorJob: (workflowId: string, input: WorkflowAuthorJobInput) => Promise<void>;
      /** Poll an async NL-generation job's status/progress/result. */
      getWorkflowAuthorJobStatus: (workflowId: string) => Promise<WorkflowAuthorJobStatus>;
      startChannelAssistant: (
        workflowId: string,
        input: ChannelAssistantTurnInput
      ) => Promise<void>;
      startReembedMemory: (workflowId: string, memoryId: string) => Promise<void>;
      startRepoDependencyInference: (workflowId: string, repoId: string) => Promise<void>;
      startEvalRunWorkflow: (
        workflowId: string,
        input: {
          evalRunId: string;
          datasetId: string;
          candidateRef: string;
          baselineRef: string;
        }
      ) => Promise<void>;
      startConsolidationWorkflow: (
        workflowId: string,
        input: ConsolidateLessonsInput
      ) => Promise<void>;
      signalWorkflow: (workflowId: string, signalName: string, args?: unknown[]) => Promise<void>;
      cancelWorkflow: (workflowId: string) => Promise<void>;
      syncConsolidationSchedule: (config: ConsolidationScheduleConfig) => Promise<void>;
      getConsolidationScheduleStatus: () => Promise<ConsolidationScheduleStatus>;
      triggerConsolidationNow: () => Promise<void>;
      syncEvalSchedule: (config: EvalScheduleConfig) => Promise<void>;
      getEvalScheduleStatus: () => Promise<EvalScheduleStatus>;
      triggerEvalNow: () => Promise<void>;
      syncRevalidationSchedule: (config: RevalidationScheduleConfig) => Promise<void>;
      getRevalidationScheduleStatus: () => Promise<RevalidationScheduleStatus>;
      triggerRevalidationNow: () => Promise<void>;
      syncRepoDependencyScanSchedule: (config: RepoDependencyScanScheduleConfig) => Promise<void>;
      syncRepoAccessSyncSchedule: (config: RepoAccessSyncScheduleConfig) => Promise<void>;
      getRepoDependencyScanScheduleStatus: () => Promise<RepoDependencyScanScheduleStatus>;
      triggerRepoDependencyScanNow: () => Promise<void>;
      syncWorkRequestSchedule: (input: WorkRequestScheduleInput) => Promise<void>;
      deleteWorkRequestSchedule: (scheduleRowId: string) => Promise<void>;
      triggerWorkRequestSchedule: (scheduleRowId: string) => Promise<void>;
      getWorkRequestScheduleStatus: (scheduleRowId: string) => Promise<WorkRequestScheduleStatus>;
      syncChannelAmbientSchedule: (input: ChannelAmbientScheduleInput) => Promise<void>;
      deleteChannelAmbientSchedule: (channelId: string) => Promise<void>;
      getChannelAmbientScheduleStatus: (channelId: string) => Promise<ChannelAmbientScheduleStatus>;
      syncChannelReactiveSchedule: (input: ChannelReactiveScheduleInput) => Promise<void>;
      deleteChannelReactiveSchedule: (channelId: string) => Promise<void>;
    };
  }
}

const temporalPlugin: FastifyPluginAsync = async (fastify) => {
  const connection = await Connection.connect({
    address: resolveTemporalAddress(),
  });
  const client = new Client({ connection });
  const schedules = new ScheduleClient({ connection });

  function makeScheduleAction(input: ScheduledConsolidationInput) {
    return {
      args: [input],
      taskQueue: 'engineering-workflow',
      type: 'startWorkflow' as const,
      workflowType: 'ScheduledConsolidationWorkflow',
    };
  }

  // Re-validation schedule action: starts ScheduledRevalidationWorkflow, which
  // re-runs each EvalCase's reference against current repo state to detect stale cases.
  function makeRevalidationScheduleAction(input: ScheduledRevalidationInput) {
    return {
      args: [input],
      taskQueue: 'engineering-workflow',
      type: 'startWorkflow' as const,
      workflowType: 'ScheduledRevalidationWorkflow',
    };
  }

  // Repo-dependency re-scan action. The workflow discovers its own repo set, so
  // the schedule carries no arguments.
  function makeRepoDependencyScanScheduleAction() {
    return {
      args: [] as unknown[],
      taskQueue: 'engineering-workflow',
      type: 'startWorkflow' as const,
      workflowType: 'ScheduledRepoDependencyScanWorkflow',
    };
  }

  // Permission-sweep action. The workflow discovers its own (user, repo) pairs,
  // so the schedule carries no arguments.
  function makeRepoAccessSyncScheduleAction() {
    return {
      args: [] as unknown[],
      taskQueue: 'engineering-workflow',
      type: 'startWorkflow' as const,
      workflowType: 'ScheduledRepoAccessSyncWorkflow',
    };
  }

  // Eval-regression schedule action: starts ScheduledEvalWorkflow, which
  // resolves the dataset slug and creates a fresh EvalRun row on each fire.
  function makeEvalScheduleAction(input: ScheduledEvalInput) {
    return {
      args: [input],
      taskQueue: 'engineering-workflow',
      type: 'startWorkflow' as const,
      workflowType: 'ScheduledEvalWorkflow',
    };
  }

  /**
   * Schedule action for a recurring work request: starts the existing
   * RunnableWorkflow directly. The base `workflowId` is `sched-<rowId>`;
   * Temporal appends the per-fire scheduled timestamp to it (server default —
   * see temporal.api.schedule.v1 `Schedule.Action` / `workflow_id` docs:
   * "it may have a timestamp appended for uniqueness"), so every fire gets a
   * unique workflow ID and therefore its own WorkflowRun row.
   */
  function makeWorkRequestScheduleAction(input: WorkRequestScheduleInput) {
    return {
      args: [
        {
          request: input.request,
          templateId: input.templateId,
          templateVersion: input.templateVersion,
        },
      ],
      taskQueue: 'engineering-workflow',
      type: 'startWorkflow' as const,
      workflowId: `sched-${input.scheduleRowId}`,
      workflowType: 'RunnableWorkflow',
    };
  }

  /**
   * Build a schedule action that starts a per-channel workflow on each fire.
   * The base `workflowId` is `<workflowIdPrefix>-<channelId>`; Temporal appends
   * the per-fire scheduled timestamp for uniqueness, so each fire gets its own
   * WorkflowRun.
   */
  function makeChannelScheduleAction(
    channelId: string,
    workflowIdPrefix: string,
    workflowType: string
  ) {
    return {
      args: [{ channelId }],
      taskQueue: 'engineering-workflow',
      type: 'startWorkflow' as const,
      workflowId: `${workflowIdPrefix}-${channelId}`,
      workflowType,
    };
  }

  /**
   * Shared describe-or-create reconciliation for a single Temporal Schedule.
   * If the schedule already exists, its cron + action (and, when `paused` is
   * provided, its paused state — preserving the rest of `prev.state`) are
   * updated in place; otherwise it is created with the SKIP overlap policy (a
   * fire while the previous run is still in flight is dropped, not stacked).
   * When `paused` is omitted, neither branch touches schedule state.
   */
  /**
   * `describe()` distinguishes "no such schedule" from "Temporal is unreachable"
   * only by error class. Treating every error as not-found made an outage look
   * like a clean slate: deletes reported success (leaving live schedules that
   * kept firing runs no row could stop) and status reads showed "not scheduled".
   */
  async function scheduleExists(handle: ScheduleHandle): Promise<boolean> {
    try {
      await handle.describe();
      return true;
    } catch (err) {
      if (err instanceof ScheduleNotFoundError) {
        return false;
      }
      throw err;
    }
  }

  async function deleteScheduleIfExists(scheduleId: string): Promise<void> {
    try {
      await schedules.getHandle(scheduleId).delete();
    } catch (err) {
      if (!(err instanceof ScheduleNotFoundError)) {
        throw err;
      }
      // Already gone (or never created) — deletion is idempotent.
    }
  }

  async function upsertSchedule(
    scheduleId: string,
    opts: { action: ScheduleOptionsAction; cronExpression: string; paused?: boolean }
  ): Promise<void> {
    const handle = schedules.getHandle(scheduleId);
    if (await scheduleExists(handle)) {
      // Schedule exists — update it in place. Any failure here is real
      // (timeout, bad cron, conflict) and must surface, not fall into create.
      await handle.update((prev) => ({
        ...prev,
        action: opts.action,
        spec: { cronExpressions: [opts.cronExpression] },
        ...(opts.paused !== undefined ? { state: { ...prev.state, paused: opts.paused } } : {}),
      }));
    } else {
      // Schedule doesn't exist yet — create it.
      await schedules.create({
        action: opts.action,
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
        scheduleId,
        spec: { cronExpressions: [opts.cronExpression] },
        ...(opts.paused !== undefined ? { state: { paused: opts.paused } } : {}),
      });
    }
  }

  fastify.decorate('temporal', {
    async cancelWorkflow(workflowId: string): Promise<void> {
      const handle = client.workflow.getHandle(workflowId);
      await handle.cancel();
    },

    // ── Channel ambient-mode digest schedules (one Temporal Schedule per
    //    SlackChannel with ambientEnabled + ambientCron) ──

    async deleteChannelAmbientSchedule(channelId: string): Promise<void> {
      await deleteScheduleIfExists(channelAmbientScheduleId(channelId));
    },

    async deleteChannelReactiveSchedule(channelId: string): Promise<void> {
      await deleteScheduleIfExists(channelReactiveScheduleId(channelId));
    },

    // ── Recurring work-request schedules (one Temporal Schedule per
    //    ScheduledWorkRequest row) ──

    async deleteWorkRequestSchedule(scheduleRowId: string): Promise<void> {
      await deleteScheduleIfExists(workRequestScheduleId(scheduleRowId));
    },

    async explainWorkflowSpec(
      workflowId: string,
      input: { spec: WorkflowSpec; teamId?: string | null }
    ): Promise<{ explanation: string }> {
      return (await client.workflow.execute('WorkflowExplainWorkflow', {
        args: [input],
        taskQueue: 'engineering-workflow',
        workflowExecutionTimeout: '3 minutes',
        workflowId,
      })) as { explanation: string };
    },

    async generateWorkflowSpec(
      workflowId: string,
      input: {
        prompt: string;
        teamId?: string | null;
        allowShell?: boolean;
        baseSpec?: WorkflowSpec;
      }
    ): Promise<{ spec: WorkflowSpec; summary: string; attempts: number }> {
      // execute() = start + await result. Bounded above the activity's 5m
      // start-to-close so the workflow doesn't time out before the activity does.
      return (await client.workflow.execute('WorkflowAuthorWorkflow', {
        args: [input],
        taskQueue: 'engineering-workflow',
        workflowExecutionTimeout: '6 minutes',
        workflowId,
      })) as { spec: WorkflowSpec; summary: string; attempts: number };
    },

    async getChannelAmbientScheduleStatus(
      channelId: string
    ): Promise<ChannelAmbientScheduleStatus> {
      try {
        const handle = schedules.getHandle(channelAmbientScheduleId(channelId));
        const desc = await handle.describe();
        const nextTimes = desc.info.nextActionTimes;
        return {
          exists: true,
          nextRunAt: nextTimes.length > 0 ? nextTimes[0].toISOString() : null,
          paused: desc.state.paused,
        };
      } catch (err) {
        if (!(err instanceof ScheduleNotFoundError)) {
          throw err;
        }
        return { exists: false, nextRunAt: null, paused: false };
      }
    },

    async getConsolidationScheduleStatus(): Promise<ConsolidationScheduleStatus> {
      try {
        const handle = schedules.getHandle(CONSOLIDATION_SCHEDULE_ID);
        const desc = await handle.describe();
        const nextTimes = desc.info.nextActionTimes;
        return {
          exists: true,
          nextRunAt: nextTimes.length > 0 ? nextTimes[0].toISOString() : null,
          paused: desc.state.paused,
        };
      } catch (err) {
        if (!(err instanceof ScheduleNotFoundError)) {
          throw err;
        }
        return { exists: false, nextRunAt: null, paused: false };
      }
    },

    async getEvalScheduleStatus(): Promise<EvalScheduleStatus> {
      try {
        const handle = schedules.getHandle(EVAL_SCHEDULE_ID);
        const desc = await handle.describe();
        const nextTimes = desc.info.nextActionTimes;
        const lastAction = desc.info.recentActions.at(-1);
        return {
          exists: true,
          lastRunAt: lastAction ? lastAction.takenAt.toISOString() : null,
          nextRunAt: nextTimes.length > 0 ? nextTimes[0].toISOString() : null,
          paused: desc.state.paused,
        };
      } catch (err) {
        if (!(err instanceof ScheduleNotFoundError)) {
          throw err;
        }
        return { exists: false, lastRunAt: null, nextRunAt: null, paused: false };
      }
    },

    async getRepoDependencyScanScheduleStatus(): Promise<RepoDependencyScanScheduleStatus> {
      try {
        const handle = schedules.getHandle(REPO_DEPENDENCY_SCAN_SCHEDULE_ID);
        const desc = await handle.describe();
        const nextTimes = desc.info.nextActionTimes;
        const lastAction = desc.info.recentActions.at(-1);
        return {
          exists: true,
          lastRunAt: lastAction ? lastAction.takenAt.toISOString() : null,
          nextRunAt: nextTimes.length > 0 ? nextTimes[0].toISOString() : null,
          paused: desc.state.paused,
        };
      } catch (err) {
        if (!(err instanceof ScheduleNotFoundError)) {
          throw err;
        }
        return { exists: false, lastRunAt: null, nextRunAt: null, paused: false };
      }
    },

    async getRevalidationScheduleStatus(): Promise<RevalidationScheduleStatus> {
      try {
        const handle = schedules.getHandle(REVALIDATION_SCHEDULE_ID);
        const desc = await handle.describe();
        const nextTimes = desc.info.nextActionTimes;
        const lastAction = desc.info.recentActions.at(-1);
        return {
          exists: true,
          lastRunAt: lastAction ? lastAction.takenAt.toISOString() : null,
          nextRunAt: nextTimes.length > 0 ? nextTimes[0].toISOString() : null,
          paused: desc.state.paused,
        };
      } catch (err) {
        if (!(err instanceof ScheduleNotFoundError)) {
          throw err;
        }
        return { exists: false, lastRunAt: null, nextRunAt: null, paused: false };
      }
    },

    async getWorkflowAuthorJobStatus(workflowId: string): Promise<WorkflowAuthorJobStatus> {
      const handle = client.workflow.getHandle(workflowId);
      let desc: Awaited<ReturnType<typeof handle.describe>>;
      try {
        desc = await handle.describe();
      } catch {
        return { code: 'NOT_FOUND', message: 'Generation job not found', status: 'failed' };
      }
      const name = desc.status.name;
      if (name === 'RUNNING') {
        let phase: string | undefined;
        try {
          const p = (await handle.query('authorJobProgress')) as { phase?: string };
          phase = p?.phase;
        } catch {
          // Query may race the handler registration at the very start — omit phase.
        }
        return { phase, status: 'running' };
      }
      if (name === 'COMPLETED') {
        // Guard the result fetch too: a payload/codec error on an otherwise
        // completed job should surface as a structured failure, not a 500 that
        // leaves the poller stuck on "Generating…".
        try {
          const result = (await handle.result()) as {
            templateId: string;
            name: string;
            summary: string;
            attempts: number;
          };
          return { result, status: 'done' };
        } catch {
          return {
            code: 'GENERATION_UNAVAILABLE',
            message: 'Generation finished but its result could not be read. Please try again.',
            status: 'failed',
          };
        }
      }
      // Terminal non-success: classify the failure. Prefer the structured
      // ApplicationFailure `type` (e.g. 'SHELL_NOT_ALLOWED'); fall back to the
      // message marker for the generation-failure case.
      let code = 'GENERATION_UNAVAILABLE';
      let message = 'Generation failed. Please try again.';
      try {
        await handle.result();
      } catch (err) {
        const types: string[] = [];
        const messages: string[] = [];
        let cur: unknown = err;
        for (let i = 0; i < 6 && cur instanceof Error; i++) {
          messages.push(cur.message);
          const t = (cur as { type?: unknown }).type;
          if (typeof t === 'string') {
            types.push(t);
          }
          cur = (cur as { cause?: unknown }).cause;
        }
        if (types.includes('SHELL_NOT_ALLOWED')) {
          code = 'SHELL_NOT_ALLOWED';
          message =
            'The generated workflow uses shell/container steps, which must be authored on the canvas.';
        } else if (messages.some((m) => m.includes('could not produce a valid WorkflowSpec'))) {
          code = 'GENERATION_FAILED';
          message =
            'The author agent could not produce a valid workflow from that description. Try rephrasing with more detail.';
        }
      }
      return { code, message, status: 'failed' };
    },

    async getWorkRequestScheduleStatus(scheduleRowId: string): Promise<WorkRequestScheduleStatus> {
      try {
        const handle = schedules.getHandle(workRequestScheduleId(scheduleRowId));
        const desc = await handle.describe();
        const nextTimes = desc.info.nextActionTimes;
        const lastAction = desc.info.recentActions.at(-1);
        return {
          exists: true,
          lastRunAt: lastAction ? lastAction.takenAt.toISOString() : null,
          nextRunAt: nextTimes.length > 0 ? nextTimes[0].toISOString() : null,
          paused: desc.state.paused,
        };
      } catch (err) {
        if (!(err instanceof ScheduleNotFoundError)) {
          throw err;
        }
        return { exists: false, lastRunAt: null, nextRunAt: null, paused: false };
      }
    },

    async signalWorkflow(
      workflowId: string,
      signalName: string,
      args: unknown[] = []
    ): Promise<void> {
      const handle = client.workflow.getHandle(workflowId);
      await handle.signal(signalName, ...args);
    },

    async startChannelAssistant(
      workflowId: string,
      input: ChannelAssistantTurnInput
    ): Promise<void> {
      // REJECT_DUPLICATE makes the deterministic `chan-<id>-<ts>` workflowId
      // idempotent: a re-delivered Slack event (same id) after the first run
      // has closed is rejected with WorkflowExecutionAlreadyStartedError rather
      // than silently starting a second run (duplicate reply + double cost).
      // The caller treats that error as a benign no-op.
      await client.workflow.start('ChannelAssistantWorkflow', {
        args: [input],
        taskQueue: 'engineering-workflow',
        workflowId,
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      });
    },

    async startConsolidationWorkflow(
      workflowId: string,
      input: ConsolidateLessonsInput
    ): Promise<void> {
      await client.workflow.start('ConsolidateLessonsWorkflow', {
        args: [input],
        taskQueue: 'engineering-workflow',
        workflowExecutionTimeout: '35 minutes',
        workflowId,
      });
    },

    async startEpicWorkflow(workflowId: string, request: EpicRequest): Promise<void> {
      await client.workflow.start('EpicOrchestratorWorkflow', {
        args: [request],
        taskQueue: 'engineering-workflow',
        workflowExecutionTimeout: '30d',
        workflowId,
      });
    },

    async startEvalRunWorkflow(
      workflowId: string,
      input: {
        evalRunId: string;
        datasetId: string;
        candidateRef: string;
        baselineRef: string;
      }
    ): Promise<void> {
      await client.workflow.start('EvalRunWorkflow', {
        args: [input],
        taskQueue: 'engineering-workflow',
        workflowExecutionTimeout: '5h',
        workflowId,
      });
    },

    async startReembedMemory(workflowId: string, memoryId: string): Promise<void> {
      // Re-embed one MemoryItem so its pgvector embedding catches up to edited
      // text. Mirrors startChannelAssistant's start-by-name; the caller wraps
      // this best-effort (a Temporal hiccup must not fail the synchronous edit).
      await client.workflow.start('ReembedMemoryWorkflow', {
        args: [{ memoryId }],
        taskQueue: 'engineering-workflow',
        workflowId,
      });
    },

    // One-shot LLM inference for a single repo. The workflow id is caller-supplied
    // and repo-derived, so Temporal's dedup collapses a double-click into one run.
    async startRepoDependencyInference(workflowId: string, repoId: string): Promise<void> {
      await client.workflow.start('InferRepoDependenciesWorkflow', {
        args: [{ repoId }],
        taskQueue: 'engineering-workflow',
        workflowId,
      });
    },

    async startRunnableWorkflow(
      workflowId: string,
      input: { templateId: string; templateVersion: number; request: RepoWorkRequest }
    ): Promise<void> {
      await client.workflow.start('RunnableWorkflow', {
        args: [input],
        taskQueue: 'engineering-workflow',
        workflowId,
      });
    },

    async startWorkflowAuthorJob(workflowId: string, input: WorkflowAuthorJobInput): Promise<void> {
      // Start without awaiting — the caller returns a job id and the client polls
      // getWorkflowAuthorJobStatus. 6m ceiling > the 5m generate activity.
      await client.workflow.start('WorkflowAuthorJobWorkflow', {
        args: [input],
        taskQueue: 'engineering-workflow',
        workflowExecutionTimeout: '6 minutes',
        workflowId,
      });
    },

    async syncChannelAmbientSchedule(input: ChannelAmbientScheduleInput): Promise<void> {
      await upsertSchedule(channelAmbientScheduleId(input.channelId), {
        action: makeChannelScheduleAction(
          input.channelId,
          'channel-ambient',
          'ChannelAmbientWorkflow'
        ),
        cronExpression: input.cronExpression,
      });
    },

    async syncChannelReactiveSchedule(input: ChannelReactiveScheduleInput): Promise<void> {
      await upsertSchedule(channelReactiveScheduleId(input.channelId), {
        action: makeChannelScheduleAction(
          input.channelId,
          'channel-reactive',
          'ChannelReactiveWorkflow'
        ),
        cronExpression: input.cronExpression,
      });
    },

    async syncConsolidationSchedule(config: ConsolidationScheduleConfig): Promise<void> {
      // Empty input: `consolidateLessons` resolves minClusterSize/similarityThreshold
      // from `resolveConsolidationConfig()` itself on each fire, so the schedule's
      // static input no longer needs to carry them — an admin's config edit applies
      // on the next fire without re-syncing the schedule.
      const input: ScheduledConsolidationInput = {};
      await upsertSchedule(CONSOLIDATION_SCHEDULE_ID, {
        action: makeScheduleAction(input),
        cronExpression: config.cronExpression,
        paused: !config.enabled,
      });
    },

    // ── Eval regression schedule (one system-wide Temporal Schedule) ──

    async syncEvalSchedule(config: EvalScheduleConfig): Promise<void> {
      const input: ScheduledEvalInput = {
        baselineRef: config.baselineRef,
        candidateRef: config.candidateRef,
        datasetSlug: config.datasetSlug,
      };
      await upsertSchedule(EVAL_SCHEDULE_ID, {
        action: makeEvalScheduleAction(input),
        cronExpression: config.cronExpression,
        paused: !config.enabled,
      });
    },

    // ── Repo-access permission sweep (one system-wide Temporal Schedule) ──

    async syncRepoAccessSyncSchedule(config: RepoAccessSyncScheduleConfig): Promise<void> {
      await upsertSchedule(REPO_ACCESS_SYNC_SCHEDULE_ID, {
        action: makeRepoAccessSyncScheduleAction(),
        cronExpression: config.cronExpression,
        paused: !config.enabled,
      });
    },

    // ── Repo-dependency re-scan schedule (one system-wide Temporal Schedule) ──

    async syncRepoDependencyScanSchedule(config: RepoDependencyScanScheduleConfig): Promise<void> {
      await upsertSchedule(REPO_DEPENDENCY_SCAN_SCHEDULE_ID, {
        action: makeRepoDependencyScanScheduleAction(),
        cronExpression: config.cronExpression,
        paused: !config.enabled,
      });
    },

    // ── Re-validation schedule (one system-wide Temporal Schedule) ──

    async syncRevalidationSchedule(config: RevalidationScheduleConfig): Promise<void> {
      const input: ScheduledRevalidationInput = {
        datasetSlug: config.datasetSlug ?? undefined,
      };
      await upsertSchedule(REVALIDATION_SCHEDULE_ID, {
        action: makeRevalidationScheduleAction(input),
        cronExpression: config.cronExpression,
        paused: !config.enabled,
      });
    },

    async syncWorkRequestSchedule(input: WorkRequestScheduleInput): Promise<void> {
      await upsertSchedule(workRequestScheduleId(input.scheduleRowId), {
        action: makeWorkRequestScheduleAction(input),
        cronExpression: input.cronExpression,
        paused: input.paused,
      });
    },

    async triggerConsolidationNow(): Promise<void> {
      const handle = schedules.getHandle(CONSOLIDATION_SCHEDULE_ID);
      await handle.trigger(ScheduleOverlapPolicy.ALLOW_ALL);
    },

    async triggerEvalNow(): Promise<void> {
      const handle = schedules.getHandle(EVAL_SCHEDULE_ID);
      await handle.trigger(ScheduleOverlapPolicy.SKIP);
    },

    // SKIP, not ALLOW_ALL: a scan sweeps every repo and writes edges, so
    // overlapping fires would race each other's find-then-write on the same rows.
    async triggerRepoDependencyScanNow(): Promise<void> {
      const handle = schedules.getHandle(REPO_DEPENDENCY_SCAN_SCHEDULE_ID);
      await handle.trigger(ScheduleOverlapPolicy.SKIP);
    },

    async triggerRevalidationNow(): Promise<void> {
      const handle = schedules.getHandle(REVALIDATION_SCHEDULE_ID);
      await handle.trigger(ScheduleOverlapPolicy.SKIP);
    },

    async triggerWorkRequestSchedule(scheduleRowId: string): Promise<void> {
      const handle = schedules.getHandle(workRequestScheduleId(scheduleRowId));
      // SKIP: a manual fire while a previous fire is still running is dropped
      // (same branch / same standing work request — overlap is never useful).
      await handle.trigger(ScheduleOverlapPolicy.SKIP);
    },
  });

  fastify.addHook('onClose', async () => {
    await connection.close();
  });
};

export { temporalPlugin };
export default fp(temporalPlugin, { fastify: '5.x', name: 'temporal' });
