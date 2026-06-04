import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyGitHubSignature } from '../lib/github.js';
import { postSlackMessage } from '../lib/slack.js';

// GitHub payloads are HMAC-verified before we get here, but a shape change or a
// non-PR/non-check event can still arrive. Validate the fields we touch so a
// malformed-but-signed body is ignored gracefully instead of throwing a 500.
const PullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({ merged: z.boolean(), number: z.number() }),
  repository: z.object({ full_name: z.string() }),
});

const CheckRunWebhookSchema = z.object({
  action: z.string(),
  check_run: z
    .object({ conclusion: z.string(), head_sha: z.string(), html_url: z.string() })
    .optional(),
  repository: z.object({ full_name: z.string() }),
});

function verifyWebhookOrReject(
  request: FastifyRequest & { rawBody?: string | Buffer },
  reply: FastifyReply
): boolean {
  const signature = request.headers['x-hub-signature-256'] as string;
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret || !signature) {
    reply
      .status(401)
      .send({ error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Missing signature' } });
    return false;
  }

  if (!request.rawBody) {
    reply.status(400).send({ error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Missing raw body' } });
    return false;
  }

  if (!verifyGitHubSignature(request.rawBody, signature, secret)) {
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
      if (!verifyWebhookOrReject(request, reply)) {
        return;
      }

      const parsed = PullRequestWebhookSchema.safeParse(request.body);
      if (!parsed.success) {
        return { data: { ignored: true, reason: 'Unrecognized payload shape' } };
      }
      const payload = parsed.data;

      // Only handle merged pull_request events
      if (payload.action !== 'closed' || !payload.pull_request.merged) {
        return { data: { ignored: true } };
      }

      const prNumber = payload.pull_request.number;
      const repoFullName = payload.repository.full_name;
      const [org, repoName] = repoFullName.split('/');

      // Find the tracked PR (include Slack context for the merge notification)
      const pullRequest = await fastify.prisma.pullRequest.findFirst({
        include: {
          workflow: {
            include: {
              repository: { include: { team: { select: { slackNotifyChannel: true } } } },
              workRequest: {
                select: { externalTicketId: true, slackChannelId: true, slackMessageTs: true },
              },
            },
          },
        },
        where: {
          prNumber,
          repository: { organizationName: org, repoName },
          status: 'OPEN',
        },
      });

      if (!pullRequest?.workflow) {
        return { data: { ignored: true, reason: 'No tracked workflow for this PR' } };
      }

      // Update PR status
      await fastify.prisma.pullRequest.update({
        data: { status: 'MERGED' },
        where: { id: pullRequest.id },
      });

      // Signal the Temporal workflow
      await fastify.temporal.signalWorkflow(
        pullRequest.workflow.temporalWorkflowId,
        'humanMergeSignal',
        [true]
      );

      // Best-effort Slack "merged" notification back to the originating channel.
      const wr = pullRequest.workflow.workRequest;
      const originChannel = wr?.slackChannelId ?? null;
      const teamChannel = pullRequest.workflow.repository?.team?.slackNotifyChannel ?? null;
      const slackChannel = originChannel ?? teamChannel;
      if (slackChannel) {
        await postSlackMessage({
          channel: slackChannel,
          text: `:merged: *[${wr?.externalTicketId ?? 'unknown'}]* PR #${prNumber} was merged`,
          ...(originChannel && wr?.slackMessageTs ? { threadTs: wr.slackMessageTs } : {}),
        }).catch(() => null);
      }

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
      if (!verifyWebhookOrReject(request, reply)) {
        return;
      }

      const parsed = CheckRunWebhookSchema.safeParse(request.body);
      if (!parsed.success) {
        return { data: { ignored: true, reason: 'Unrecognized payload shape' } };
      }
      const payload = parsed.data;

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
        include: { workflow: true },
        where: {
          headSha,
          repository: { organizationName: org, repoName },
          status: 'OPEN',
        },
      });

      if (pullRequests.length === 0) {
        return { data: { ignored: true, reason: 'No tracked PR for this commit' } };
      }

      // Batch-update CI status in a single transaction to avoid N+1 queries
      const passed = conclusion === 'success';
      await fastify.prisma.$transaction(
        pullRequests.map((pr: (typeof pullRequests)[number]) =>
          fastify.prisma.pullRequest.update({
            data: { ciStatus: passed ? 'PASSED' : 'FAILED' },
            where: { id: pr.id },
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
            fastify.temporal.signalWorkflow(wfId, 'ciPipelineSignal', [{ logsUrl, passed }])
          );
        }
      }
      const results = await Promise.allSettled(signalPromises);
      for (const r of results) {
        if (r.status === 'rejected') {
          request.log.error({ err: r.reason }, 'Failed to signal workflow');
        }
      }

      return { data: { conclusion, signaled } };
    }
  );
};
