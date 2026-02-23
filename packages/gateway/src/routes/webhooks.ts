import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';

export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/v1/webhooks/git
  // Uses fastify-raw-body for HMAC verification
  fastify.post('/git', {
    config: { rawBody: true },
  }, async (request, reply) => {
    // Verify GitHub HMAC signature
    const signature = request.headers['x-hub-signature-256'] as string;
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (!secret || !signature) {
      return reply.status(401).send({ error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Missing signature' } });
    }

    const expected =
      'sha256=' +
      crypto.createHmac('sha256', secret).update((request as any).rawBody!).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return reply.status(401).send({ error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Invalid signature' } });
    }

    const payload = request.body as any;

    // Only handle merged pull_request events
    if (payload.action !== 'closed' || !payload.pull_request?.merged) {
      return { data: { ignored: true } };
    }

    const prNumber = payload.pull_request.number;
    const repoFullName = payload.repository.full_name;
    const [org, repoName] = repoFullName.split('/');

    // Find the tracked PR
    const pullRequest = await fastify.prisma.pullRequest.findFirst({
      where: {
        prNumber,
        repository: { organizationName: org, repoName },
        status: 'OPEN',
      },
      include: { workflow: true },
    });

    if (!pullRequest?.workflow) {
      return { data: { ignored: true, reason: 'No tracked workflow for this PR' } };
    }

    // Update PR status
    await fastify.prisma.pullRequest.update({
      where: { id: pullRequest.id },
      data: { status: 'MERGED' },
    });

    // Signal the Temporal workflow
    await fastify.temporal.signalWorkflow(
      pullRequest.workflow.temporalWorkflowId,
      'humanMergeSignal',
      [true],
    );

    return { data: { signalSent: true, workflowId: pullRequest.workflow.temporalWorkflowId } };
  });
};
