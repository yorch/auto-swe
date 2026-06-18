import crypto from 'node:crypto';
import { isInputSchema, validateInputPayload } from '@auto-swe/shared/lib/inputSchema';
import { resolveGitHubConfig, resolveSlackConfig } from '@auto-swe/shared/lib/systemConfig';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { verifyGitHubSignature } from '../lib/github.js';
import { getErrorName } from '../plugins/auth.js';
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

// ── GitHub payload → domain-event normalization ──
//
// The route handlers below operate on these provider-agnostic events; only
// the normalize functions know GitHub's payload shapes. A future GitLab
// webhook route maps its own payloads to the same event types and reuses the
// downstream DB-update + Temporal-signal logic unchanged.

/** A PR-merge domain event extracted from a provider webhook payload. */
export type PullRequestMergedEvent =
  /** Payload didn't match the expected shape at all. */
  | { type: 'unrecognized' }
  /** Valid payload but not a merged-PR event (e.g. opened, closed-unmerged). */
  | { type: 'ignored' }
  | { type: 'merged'; prNumber: number; org: string; repoName: string };

/** A CI check-completion domain event extracted from a provider webhook payload. */
export type CheckRunCompletedEvent =
  | { type: 'unrecognized' }
  /** Valid payload but not a completed check run. */
  | { type: 'ignored' }
  | {
      type: 'completed';
      org: string;
      repoName: string;
      headSha: string;
      conclusion: string;
      logsUrl: string;
    };

/** Pure mapping from a GitHub `pull_request` webhook body to a domain event. */
export function normalizeGitHubPullRequestEvent(body: unknown): PullRequestMergedEvent {
  const parsed = PullRequestWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return { type: 'unrecognized' };
  }
  const payload = parsed.data;

  // Only handle merged pull_request events
  if (payload.action !== 'closed' || !payload.pull_request.merged) {
    return { type: 'ignored' };
  }

  const [org, repoName] = payload.repository.full_name.split('/');
  return {
    org,
    prNumber: payload.pull_request.number,
    repoName,
    type: 'merged',
  };
}

/** Pure mapping from a GitHub `check_run` webhook body to a domain event. */
export function normalizeGitHubCheckRunEvent(body: unknown): CheckRunCompletedEvent {
  const parsed = CheckRunWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return { type: 'unrecognized' };
  }
  const payload = parsed.data;

  // Handle check_run completed events
  const checkRun = payload.check_run;
  if (!checkRun || payload.action !== 'completed') {
    return { type: 'ignored' };
  }

  const [org, repoName] = payload.repository.full_name.split('/');
  return {
    conclusion: checkRun.conclusion,
    headSha: checkRun.head_sha,
    logsUrl: checkRun.html_url,
    org,
    repoName,
    type: 'completed',
  };
}

async function verifyWebhookOrReject(
  request: FastifyRequest & { rawBody?: string | Buffer },
  reply: FastifyReply
): Promise<boolean> {
  const signature = request.headers['x-hub-signature-256'] as string;
  const { webhookSecret: secret } = await resolveGitHubConfig();

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

/** Conclusions that don't fail a check suite. */
const NON_FAILING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

interface AggregatedChecks {
  /** True when every check run on the SHA has completed. */
  complete: boolean;
  /** True when no completed run has a failing conclusion. */
  passed: boolean;
  /** html_url of the first failing run, for the CI-fix loop's log fetch. */
  failingLogsUrl?: string;
}

/**
 * Aggregate all check runs for a commit. A PR typically has several check
 * runs (lint, test, build, third-party apps); signaling the workflow on the
 * first completed run would resume it on a partial result. Returns null when
 * aggregation is unavailable (no PAT configured, API error) — callers fall
 * back to legacy per-run signaling rather than stranding the workflow.
 */
async function aggregateCheckRuns(
  apiUrl: string,
  token: string | null,
  org: string,
  repoName: string,
  headSha: string
): Promise<AggregatedChecks | null> {
  if (!token) {
    return null;
  }
  try {
    const res = await fetch(
      `${apiUrl}/repos/${org}/${repoName}/commits/${headSha}/check-runs?per_page=100`,
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `Bearer ${token}`,
        },
      }
    );
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as {
      check_runs?: Array<{ status: string; conclusion: string | null; html_url: string }>;
    };
    const runs = body.check_runs ?? [];
    if (runs.length === 0) {
      return null;
    }
    const complete = runs.every((r) => r.status === 'completed');
    const failing = runs.find(
      (r) => r.status === 'completed' && !NON_FAILING_CONCLUSIONS.has(r.conclusion ?? '')
    );
    return {
      complete,
      passed: !failing,
      ...(failing ? { failingLogsUrl: failing.html_url } : {}),
    };
  } catch {
    return null;
  }
}

const TriggerParams = z.object({ token: z.string().min(1) });

export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/v1/webhooks/git
  fastify.post(
    '/git',
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      if (!(await verifyWebhookOrReject(request, reply))) {
        return;
      }

      const event = normalizeGitHubPullRequestEvent(request.body);
      if (event.type === 'unrecognized') {
        return { data: { ignored: true, reason: 'Unrecognized payload shape' } };
      }
      if (event.type === 'ignored') {
        return { data: { ignored: true } };
      }

      const { org, prNumber, repoName } = event;

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
        const { botToken } = await resolveSlackConfig();
        await postSlackMessage(
          {
            channel: slackChannel,
            text: `:merged: *[${wr?.externalTicketId ?? 'unknown'}]* PR #${prNumber} was merged`,
            ...(originChannel && wr?.slackMessageTs ? { threadTs: wr.slackMessageTs } : {}),
          },
          botToken ?? undefined
        ).catch(() => null);
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
      if (!(await verifyWebhookOrReject(request, reply))) {
        return;
      }

      const event = normalizeGitHubCheckRunEvent(request.body);
      if (event.type === 'unrecognized') {
        return { data: { ignored: true, reason: 'Unrecognized payload shape' } };
      }
      if (event.type === 'ignored') {
        return { data: { ignored: true } };
      }

      const { conclusion, headSha, org, repoName } = event;
      let logsUrl = event.logsUrl;

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

      // A failing run decides the outcome on its own — signal immediately so
      // the CI-fix loop gets the failing logs without waiting for the rest.
      let passed = conclusion === 'success';
      if (NON_FAILING_CONCLUSIONS.has(conclusion)) {
        // A passing run says nothing about the other checks on the SHA.
        // Aggregate and only signal once everything has completed.
        const { apiUrl, token } = await resolveGitHubConfig();
        const aggregated = await aggregateCheckRuns(apiUrl, token ?? null, org, repoName, headSha);
        if (aggregated) {
          if (!aggregated.complete) {
            return {
              data: { conclusion, deferred: true, reason: 'Other check runs still in progress' },
            };
          }
          passed = aggregated.passed;
          if (!passed && aggregated.failingLogsUrl) {
            logsUrl = aggregated.failingLogsUrl;
          }
        } else {
          request.log.warn(
            { headSha, repoFullName: `${org}/${repoName}` },
            'check-run aggregation unavailable (no PAT or API error); signaling per run'
          );
        }
      }

      // Batch-update CI status in a single transaction to avoid N+1 queries
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

  // ── Public webhook trigger ──
  // POST /api/v1/webhooks/:token — no auth, secured by opaque token.
  // Looks up the template by webhookToken, validates the payload against its
  // inputSchema (if any), then starts a RunnableWorkflow.
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.post(
    '/:token',
    { schema: { body: z.record(z.string(), z.unknown()).optional(), params: TriggerParams } },
    async (request, reply) => {
      const { token } = request.params;
      const template = await fastify.prisma.workflowTemplate.findUnique({
        include: { team: { select: { slug: true } } },
        where: { webhookToken: token },
      });
      if (!template) {
        return reply
          .status(404)
          .send({ error: { code: 'WEBHOOK_NOT_FOUND', message: 'Webhook not found' } });
      }
      if (template.status !== 'ACTIVE') {
        return reply
          .status(409)
          .send({ error: { code: 'TEMPLATE_NOT_ACTIVE', message: 'Template is not active' } });
      }
      if (template.activeVersion === null) {
        return reply
          .status(409)
          .send({ error: { code: 'NO_ACTIVE_VERSION', message: 'Template has no active version' } });
      }

      const payload = request.body ?? {};

      if (template.inputSchema && isInputSchema(template.inputSchema)) {
        const result = validateInputPayload(template.inputSchema, payload);
        if (!result.ok) {
          return reply
            .status(422)
            .send({ error: { code: 'VALIDATION_ERROR', errors: result.errors } });
        }
      }

      // Extract well-known fields from the payload (same as POST /:id/runs).
      const connectionId =
        typeof payload.connectionId === 'string' ? payload.connectionId : null;
      const description =
        typeof payload.description === 'string' ? payload.description : '';
      const externalTicketId =
        typeof payload.ticketId === 'string'
          ? payload.ticketId
          : `webhook-${Date.now()}`;

      const workRequestId = crypto.randomUUID();
      const shortTplId = template.id.replace(/-/g, '').slice(0, 8);
      const temporalWorkflowId = `wh-${shortTplId}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

      try {
        await fastify.temporal.startRunnableWorkflow(temporalWorkflowId, {
          request: {
            budgetTier: 'STANDARD',
            description,
            externalTicketId,
            repoId: connectionId ?? '',
            requestPayload: JSON.stringify(payload),
            workRequestId,
          },
          templateId: template.id,
          templateVersion: template.activeVersion,
        });
      } catch (err: unknown) {
        if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
          return reply
            .status(409)
            .send({ error: { code: 'RUN_CONFLICT', message: 'A run with this workflow ID already exists' } });
        }
        throw err;
      }

      await fastify.prisma.runInput.create({
        data: {
          connectionId,
          description,
          externalTicketId,
          id: workRequestId,
          payload: payload as object,
          requestedById: null,
          requestPayload: JSON.stringify(payload),
          templateId: template.id,
          templateVersion: template.activeVersion,
        },
      });

      const activeWorkflow = await fastify.prisma.activeWorkflow.create({
        data: {
          budgetTier: 'STANDARD',
          currentStatus: 'IMPLEMENTING',
          repoId: connectionId ?? null,
          temporalWorkflowId,
          workRequestId,
        },
      });

      return reply
        .status(201)
        .send({ data: { temporalWorkflowId, workflowId: activeWorkflow.id, workRequestId } });
    }
  );
};
