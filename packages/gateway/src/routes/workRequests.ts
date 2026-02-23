import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { generateWorkflowId, generateBranchName } from '@auto-swe/shared/lib/workflowId';

const CreateWorkRequestSchema = z.object({
  externalTicketId: z.string().min(1),
  description: z.string().min(1, 'description is required — tell the agent what to implement'),
  repoIds: z.array(z.string().uuid()).min(1).max(1), // MVP: single repo only
});

export const workRequestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post('/', {
    schema: {
      body: CreateWorkRequestSchema,
    },
  }, async (request, reply) => {
    const { externalTicketId, description, repoIds } = request.body;

    // Verify repository exists
    const repo = await fastify.prisma.repository.findUnique({ where: { id: repoIds[0] } });
    if (!repo || !repo.isActive) {
      return reply.status(404).send({
        error: { code: 'REPO_NOT_FOUND', message: `Repository ${repoIds[0]} not found or inactive` },
      });
    }

    // Generate deterministic workflow ID (includes org to prevent cross-org collisions)
    const temporalWorkflowId = generateWorkflowId(
      externalTicketId,
      repo.organizationName,
      repo.repoName,
    );
    const branch = generateBranchName(externalTicketId);

    // Start Temporal workflow FIRST — this is the idempotency gate.
    // If the workflow already exists, Temporal returns WorkflowExecutionAlreadyStartedError
    // and we haven't written any orphan DB rows yet.
    try {
      await fastify.temporal.startWorkflow(temporalWorkflowId, {
        workRequestId: '', // Placeholder — workflow reads from DB via repoId
        repoId: repo.id,
        externalTicketId,
        description,
        requestPayload: JSON.stringify(request.body),
      });
    } catch (err: any) {
      if (err.name === 'WorkflowExecutionAlreadyStartedError') {
        return reply.status(409).send({
          error: { code: 'WORKFLOW_ALREADY_EXISTS', message: `Workflow already running for ${externalTicketId}` },
        });
      }
      throw err;
    }

    // Workflow started — now persist to DB.
    // If DB write fails, the Temporal workflow will eventually time out,
    // which is preferable to orphan DB rows that block future retries.
    const workRequest = await fastify.prisma.workRequest.create({
      data: {
        externalTicketId,
        description,
        requestPayload: JSON.stringify(request.body),
      },
    });

    const activeWorkflow = await fastify.prisma.activeWorkflow.create({
      data: {
        temporalWorkflowId,
        workRequestId: workRequest.id,
        repoId: repo.id,
        currentStatus: 'IMPLEMENTING',
        assignedBranch: branch,
      },
    });

    return reply.status(201).send({
      data: {
        workRequestId: workRequest.id,
        workflowIds: [activeWorkflow.id],
      },
    });
  });
};
