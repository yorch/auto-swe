import type {
  ChannelAssistantTurnInput,
  ConsolidateLessonsInput,
  EpicRequest,
  RepoWorkRequest,
  ScheduledConsolidationInput,
  ScheduledEvalInput,
} from '@auto-swe/shared/types/workflow';
import { Client, Connection, ScheduleClient, ScheduleOverlapPolicy } from '@temporalio/client';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

export const CONSOLIDATION_SCHEDULE_ID = 'auto-swe-lesson-consolidation';
export const EVAL_SCHEDULE_ID = 'auto-swe-eval-regression';

/** Temporal Schedule ID for a ScheduledWorkRequest row. */
export function workRequestScheduleId(scheduleRowId: string): string {
  return `auto-swe-scheduled-wr-${scheduleRowId}`;
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

  fastify.decorate('temporal', {
    async cancelWorkflow(workflowId: string): Promise<void> {
      const handle = client.workflow.getHandle(workflowId);
      await handle.cancel();
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
      await client.workflow.start('ChannelAssistantWorkflow', {
        args: [input],
        taskQueue: 'engineering-workflow',
        workflowId,
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

    async syncConsolidationSchedule(config: ConsolidationScheduleConfig): Promise<void> {
      const input: ScheduledConsolidationInput = {
        minClusterSize: config.minClusterSize,
        similarityThreshold: config.similarityThreshold,
      };
      const handle = schedules.getHandle(CONSOLIDATION_SCHEDULE_ID);

      try {
        await handle.describe();
        // Schedule exists — update it in place.
        await handle.update((prev) => ({
          ...prev,
          action: makeScheduleAction(input),
          spec: { cronExpressions: [config.cronExpression] },
          state: { ...prev.state, paused: !config.enabled },
        }));
      } catch {
        // Schedule doesn't exist yet — create it.
        await schedules.create({
          action: makeScheduleAction(input),
          policies: { overlap: ScheduleOverlapPolicy.SKIP },
          scheduleId: CONSOLIDATION_SCHEDULE_ID,
          spec: { cronExpressions: [config.cronExpression] },
          state: { paused: !config.enabled },
        });
      }
    },

    // ── Eval regression schedule (one system-wide Temporal Schedule) ──

    async syncEvalSchedule(config: EvalScheduleConfig): Promise<void> {
      const input: ScheduledEvalInput = {
        baselineRef: config.baselineRef,
        candidateRef: config.candidateRef,
        datasetSlug: config.datasetSlug,
      };
      const handle = schedules.getHandle(EVAL_SCHEDULE_ID);
      try {
        await handle.describe();
        await handle.update((prev) => ({
          ...prev,
          action: makeEvalScheduleAction(input),
          spec: { cronExpressions: [config.cronExpression] },
          state: { ...prev.state, paused: !config.enabled },
        }));
      } catch {
        // SKIP overlap: a full benchmark can run for hours, so a fire while the
        // previous run is still in flight is dropped rather than stacked.
        await schedules.create({
          action: makeEvalScheduleAction(input),
          policies: { overlap: ScheduleOverlapPolicy.SKIP },
          scheduleId: EVAL_SCHEDULE_ID,
          spec: { cronExpressions: [config.cronExpression] },
          state: { paused: !config.enabled },
        });
      }
    },

    async syncWorkRequestSchedule(input: WorkRequestScheduleInput): Promise<void> {
      const handle = schedules.getHandle(workRequestScheduleId(input.scheduleRowId));
      try {
        await handle.describe();
        // Schedule exists — update it in place (cron, args, paused state).
        await handle.update((prev) => ({
          ...prev,
          action: makeWorkRequestScheduleAction(input),
          spec: { cronExpressions: [input.cronExpression] },
          state: { ...prev.state, paused: input.paused },
        }));
      } catch {
        // Schedule doesn't exist yet — create it. SKIP overlap: if last
        // week's run is still in flight, this week's fire is dropped rather
        // than stacked (matches budget-cap intent).
        await schedules.create({
          action: makeWorkRequestScheduleAction(input),
          policies: { overlap: ScheduleOverlapPolicy.SKIP },
          scheduleId: workRequestScheduleId(input.scheduleRowId),
          spec: { cronExpressions: [input.cronExpression] },
          state: { paused: input.paused },
        });
      }
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
