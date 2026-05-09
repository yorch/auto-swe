import type { EpicRequest, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { Client, Connection } from '@temporalio/client';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    temporal: {
      startWorkflow: (workflowId: string, request: RepoWorkRequest) => Promise<void>;
      startEpicWorkflow: (workflowId: string, request: EpicRequest) => Promise<void>;
      signalWorkflow: (workflowId: string, signalName: string, args?: unknown[]) => Promise<void>;
    };
  }
}

const temporalPlugin: FastifyPluginAsync = async (fastify) => {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const client = new Client({ connection });

  fastify.decorate('temporal', {
    async startWorkflow(workflowId: string, request: RepoWorkRequest): Promise<void> {
      await client.workflow.start('EngineeringWorkflow', {
        taskQueue: 'engineering-workflow',
        workflowId,
        args: [request],
      });
    },

    async startEpicWorkflow(workflowId: string, request: EpicRequest): Promise<void> {
      await client.workflow.start('EpicOrchestratorWorkflow', {
        taskQueue: 'engineering-workflow',
        workflowId,
        args: [request],
      });
    },

    async signalWorkflow(
      workflowId: string,
      signalName: string,
      args: unknown[] = []
    ): Promise<void> {
      const handle = client.workflow.getHandle(workflowId);
      await handle.signal(signalName, ...args);
    },
  });

  fastify.addHook('onClose', async () => {
    await connection.close();
  });
};

export { temporalPlugin };
export default fp(temporalPlugin, { fastify: '5.x', name: 'temporal' });
