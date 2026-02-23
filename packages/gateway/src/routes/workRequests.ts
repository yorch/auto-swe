import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

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

    // Create work request
    const workRequest = await fastify.prisma.workRequest.create({
      data: {
        externalTicketId,
        description,
        requestPayload: JSON.stringify(request.body),
      },
    });

    // Generate Temporal workflow ID (deterministic for idempotency)
    const temporalWorkflowId = `eng-${externalTicketId}-${repo.repoName}`;
    const branchPrefix = process.env.BRANCH_PREFIX ?? 'auto';
    const branch = `${branchPrefix}/${externalTicketId}`;

    // Create ActiveWorkflow record
    const activeWorkflow = await fastify.prisma.activeWorkflow.create({
      data: {
        temporalWorkflowId,
        workRequestId: workRequest.id,
        repoId: repo.id,
        currentStatus: 'IMPLEMENTING',
        assignedBranch: branch,
      },
    });

    // Start Temporal workflow
    try {
      await fastify.temporal.startWorkflow(temporalWorkflowId, {
        workRequestId: workRequest.id,
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

    return reply.status(201).send({
      data: {
        workRequestId: workRequest.id,
        workflowIds: [activeWorkflow.id],
      },
    });
  });
};
