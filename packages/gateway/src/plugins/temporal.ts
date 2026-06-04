import type {
  ConsolidateLessonsInput,
  EpicRequest,
  RepoWorkRequest,
  ScheduledConsolidationInput,
} from '@auto-swe/shared/types/workflow';
import { Client, Connection, ScheduleClient, ScheduleOverlapPolicy } from '@temporalio/client';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

export const CONSOLIDATION_SCHEDULE_ID = 'auto-swe-lesson-consolidation';

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

declare module 'fastify' {
  interface FastifyInstance {
    temporal: {
      startRunnableWorkflow: (
        workflowId: string,
        input: { templateId: string; templateVersion: number; request: RepoWorkRequest }
      ) => Promise<void>;
      startEpicWorkflow: (workflowId: string, request: EpicRequest) => Promise<void>;
      startConsolidationWorkflow: (
        workflowId: string,
        input: ConsolidateLessonsInput
      ) => Promise<void>;
      signalWorkflow: (workflowId: string, signalName: string, args?: unknown[]) => Promise<void>;
      cancelWorkflow: (workflowId: string) => Promise<void>;
      syncConsolidationSchedule: (config: ConsolidationScheduleConfig) => Promise<void>;
      getConsolidationScheduleStatus: () => Promise<ConsolidationScheduleStatus>;
      triggerConsolidationNow: () => Promise<void>;
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

  fastify.decorate('temporal', {
    async cancelWorkflow(workflowId: string): Promise<void> {
      const handle = client.workflow.getHandle(workflowId);
      await handle.cancel();
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

    async signalWorkflow(
      workflowId: string,
      signalName: string,
      args: unknown[] = []
    ): Promise<void> {
      const handle = client.workflow.getHandle(workflowId);
      await handle.signal(signalName, ...args);
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

    async triggerConsolidationNow(): Promise<void> {
      const handle = schedules.getHandle(CONSOLIDATION_SCHEDULE_ID);
      await handle.trigger(ScheduleOverlapPolicy.ALLOW_ALL);
    },
  });

  fastify.addHook('onClose', async () => {
    await connection.close();
  });
};

export { temporalPlugin };
export default fp(temporalPlugin, { fastify: '5.x', name: 'temporal' });
