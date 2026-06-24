import type {
  ChannelAssistantTurnInput,
  ConsolidateLessonsInput,
  EpicRequest,
  RepoWorkRequest,
  ScheduledConsolidationInput,
  ScheduledEvalInput,
} from '@auto-swe/shared/types/workflow';
import {
  Client,
  Connection,
  ScheduleClient,
  type ScheduleOptionsAction,
  ScheduleOverlapPolicy,
  WorkflowIdReusePolicy,
} from '@temporalio/client';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

export const CONSOLIDATION_SCHEDULE_ID = 'auto-swe-lesson-consolidation';
export const EVAL_SCHEDULE_ID = 'auto-swe-eval-regression';

/** Temporal Schedule ID for a ScheduledWorkRequest row. */
export function workRequestScheduleId(scheduleRowId: string): string {
  return `auto-swe-scheduled-wr-${scheduleRowId}`;
}

/** Temporal Schedule ID for a SlackChannel's ambient-mode digest (Claude-Tag P3). */
export function channelAmbientScheduleId(channelId: string): string {
  return `auto-swe-channel-ambient-${channelId}`;
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

declare module 'fastify' {
  interface FastifyInstance {
    temporal: {
      startRunnableWorkflow: (
        workflowId: string,
        input: { templateId: string; templateVersion: number; request: RepoWorkRequest }
      ) => Promise<void>;
      startEpicWorkflow: (workflowId: string, request: EpicRequest) => Promise<void>;
      startChannelAssistant: (
        workflowId: string,
        input: ChannelAssistantTurnInput
      ) => Promise<void>;
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
      syncWorkRequestSchedule: (input: WorkRequestScheduleInput) => Promise<void>;
      deleteWorkRequestSchedule: (scheduleRowId: string) => Promise<void>;
      triggerWorkRequestSchedule: (scheduleRowId: string) => Promise<void>;
      getWorkRequestScheduleStatus: (scheduleRowId: string) => Promise<WorkRequestScheduleStatus>;
      syncChannelAmbientSchedule: (input: ChannelAmbientScheduleInput) => Promise<void>;
      deleteChannelAmbientSchedule: (channelId: string) => Promise<void>;
      getChannelAmbientScheduleStatus: (channelId: string) => Promise<ChannelAmbientScheduleStatus>;
    };
  }
}

const temporalPlugin: FastifyPluginAsync = async (fastify) => {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
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
   * Schedule action for a channel's ambient digest: starts the worker's
   * ChannelAmbientWorkflow (by name) on each fire. The base `workflowId` is
   * `channel-ambient-<channelId>`; Temporal appends the per-fire scheduled
   * timestamp for uniqueness, so each fire gets its own WorkflowRun.
   */
  function makeChannelAmbientScheduleAction(input: ChannelAmbientScheduleInput) {
    return {
      args: [{ channelId: input.channelId }],
      taskQueue: 'engineering-workflow',
      type: 'startWorkflow' as const,
      workflowId: `channel-ambient-${input.channelId}`,
      workflowType: 'ChannelAmbientWorkflow',
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
  async function upsertSchedule(
    scheduleId: string,
    opts: { action: ScheduleOptionsAction; cronExpression: string; paused?: boolean }
  ): Promise<void> {
    const handle = schedules.getHandle(scheduleId);
    try {
      await handle.describe();
      // Schedule exists — update it in place.
      await handle.update((prev) => ({
        ...prev,
        action: opts.action,
        spec: { cronExpressions: [opts.cronExpression] },
        ...(opts.paused !== undefined ? { state: { ...prev.state, paused: opts.paused } } : {}),
      }));
    } catch {
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
      const handle = schedules.getHandle(channelAmbientScheduleId(channelId));
      try {
        await handle.delete();
      } catch {
        // Already gone (or never created) — deletion is idempotent.
      }
    },

    // ── Recurring work-request schedules (one Temporal Schedule per
    //    ScheduledWorkRequest row) ──

    async deleteWorkRequestSchedule(scheduleRowId: string): Promise<void> {
      const handle = schedules.getHandle(workRequestScheduleId(scheduleRowId));
      try {
        await handle.delete();
      } catch {
        // Already gone (or never created) — deletion is idempotent.
      }
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
      } catch {
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
      } catch {
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
      } catch {
        return { exists: false, lastRunAt: null, nextRunAt: null, paused: false };
      }
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
      } catch {
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

    async syncChannelAmbientSchedule(input: ChannelAmbientScheduleInput): Promise<void> {
      await upsertSchedule(channelAmbientScheduleId(input.channelId), {
        action: makeChannelAmbientScheduleAction(input),
        cronExpression: input.cronExpression,
      });
    },

    async syncConsolidationSchedule(config: ConsolidationScheduleConfig): Promise<void> {
      const input: ScheduledConsolidationInput = {
        minClusterSize: config.minClusterSize,
        similarityThreshold: config.similarityThreshold,
      };
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
