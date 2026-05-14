import type { EpicRequest, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { Client, Connection } from '@temporalio/client';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    temporal: {
      startRunnableWorkflow: (
        workflowId: string,
        input: { templateId: string; templateVersion: number; request: RepoWorkRequest }
      ) => Promise<void>;
      startEpicWorkflow: (workflowId: string, request: EpicRequest) => Promise<void>;
      signalWorkflow: (workflowId: string, signalName: string, args?: unknown[]) => Promise<void>;
      cancelWorkflow: (workflowId: string) => Promise<void>;
    };
  }
}

const temporalPlugin: FastifyPluginAsync = async (fastify) => {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const client = new Client({ connection });

  fastify.decorate('temporal', {
    async cancelWorkflow(workflowId: string): Promise<void> {
      const handle = client.workflow.getHandle(workflowId);
      await handle.cancel();
    },

    async signalWorkflow(
      workflowId: string,
      signalName: string,
      args: unknown[] = []
    ): Promise<void> {
      const handle = client.workflow.getHandle(workflowId);
      await handle.signal(signalName, ...args);
    },

    async startEpicWorkflow(workflowId: string, request: EpicRequest): Promise<void> {
      await client.workflow.start('EpicOrchestratorWorkflow', {
        args: [request],
        taskQueue: 'engineering-workflow',
        // Hard upper bound. A child workflow that hangs indefinitely (e.g. waiting
        // on a never-arriving human merge) cannot keep the epic alive forever.
        // Temporal terminates the workflow on timeout; child workflows are released
        // via PARENT_CLOSE_POLICY_REQUEST_CANCEL set in the orchestrator.
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
  });

  fastify.addHook('onClose', async () => {
    await connection.close();
  });
};

export { temporalPlugin };
export default fp(temporalPlugin, { fastify: '5.x', name: 'temporal' });
