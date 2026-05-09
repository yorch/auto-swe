import type { FastifyPluginAsync } from 'fastify';
import { verifyGitHubSignature } from '../lib/github.js';

function verifyWebhookOrReject(request: any, reply: any): boolean {
  const signature = request.headers['x-hub-signature-256'] as string;
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret || !signature) {
    reply
      .status(401)
      .send({ error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Missing signature' } });
    return false;
  }

  if (!verifyGitHubSignature(request.rawBody!, signature, secret)) {
    reply
      .status(401)
      .send({ error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Invalid signature' } });
    return false;
  }

  return true;
}

export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/v1/webhooks/git
  fastify.post(
    '/git',
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      if (!verifyWebhookOrReject(request, reply)) return;

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
        [true]
      );

      return { data: { signalSent: true, workflowId: pullRequest.workflow.temporalWorkflowId } };
    }
  );

  // POST /api/v1/webhooks/ci
  fastify.post(
    '/ci',
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      if (!verifyWebhookOrReject(request, reply)) return;

      const payload = request.body as any;

      // Handle check_run completed events
      const checkRun = payload.check_run;
      if (!checkRun || payload.action !== 'completed') {
        return { data: { ignored: true } };
      }

      const repoFullName = payload.repository.full_name;
      const [org, repoName] = repoFullName.split('/');
      const headSha = checkRun.head_sha;
      const conclusion = checkRun.conclusion;
      const logsUrl = checkRun.html_url;

      // Find tracked PRs by commit SHA
      const pullRequests = await fastify.prisma.pullRequest.findMany({
        where: {
          headSha,
          repository: { organizationName: org, repoName },
          status: 'OPEN',
        },
        include: { workflow: true },
      });

      if (pullRequests.length === 0) {
        return { data: { ignored: true, reason: 'No tracked PR for this commit' } };
      }

      // Batch-update CI status in a single transaction to avoid N+1 queries
      const passed = conclusion === 'success';
      await fastify.prisma.$transaction(
        pullRequests.map((pr: (typeof pullRequests)[number]) =>
          fastify.prisma.pullRequest.update({
            where: { id: pr.id },
            data: { ciStatus: passed ? 'PASSED' : 'FAILED' },
          })
        )
      );

      // Signal all affected Temporal workflows in parallel
      const signaled: string[] = [];
      const signalPromises: Promise<unknown>[] = [];
      for (const pr of pullRequests) {
        if (pr.workflow) {
          const wfId = pr.workflow.temporalWorkflowId;
          signaled.push(wfId);
          signalPromises.push(
            fastify.temporal.signalWorkflow(wfId, 'ciPipelineSignal', [{ passed, logsUrl }])
          );
        }
      }
      const results = await Promise.allSettled(signalPromises);
      for (const r of results) {
        if (r.status === 'rejected') {
          request.log.error({ err: r.reason }, 'Failed to signal workflow');
        }
      }

      return { data: { signaled, conclusion } };
    }
  );
};
