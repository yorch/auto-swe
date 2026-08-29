import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { isInputSchema, validateInputPayload } from '@auto-swe/shared/lib/inputSchema';
import {
  resolveGitHubConfig,
  resolveIssueTrackerConfig,
  resolveSlackBotTokenForSlackChannel,
} from '@auto-swe/shared/lib/systemConfig';
import { syncTrackerOnEvent } from '@auto-swe/shared/lib/trackerSync';
import {
  getWorkspaceProviderMetadata,
  isWorkspaceProviderType,
} from '@auto-swe/shared/lib/workspaceProviders';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GITHUB_MAX_PAGES, GITHUB_PER_PAGE, verifyGitHubSignature } from '../lib/github.js';
import { IdempotencyHeaderSchema, workflowIdFromIdempotencyKey } from '../lib/idempotency.js';
import { assertOrgBudget } from '../lib/orgAccess.js';
import { validateRunConnection } from '../lib/runConnection.js';
import { postSlackMessage } from '../lib/slack.js';
// The webhook handlers below undo their DB write and answer non-2xx when a
// signal fails, so the delivery can be sent again — only ever useful for a
// TRANSIENT failure. See `lib/temporalErrors.ts` for why a terminal one keeps
// the write and answers 2xx instead.
import { isTerminalSignalError } from '../lib/temporalErrors.js';
import { launchTrackedWorkflow } from '../lib/workflowLaunch.js';

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
 * aggregation is unavailable (no PAT configured, API error, or the run count
 * exceeds what `GITHUB_MAX_PAGES` pages can cover) — callers fall back to
 * legacy per-run signaling rather than stranding the workflow or computing
 * "complete" from a truncated view.
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
  type RawCheckRun = { status: string; conclusion: string | null; html_url: string };
  const runs: RawCheckRun[] = [];
  // Did we actually page to the end of the result set? Only then can "complete"
  // be trusted; otherwise the caller falls back to legacy per-run signaling.
  let reachedEnd = false;
  try {
    for (let page = 1; page <= GITHUB_MAX_PAGES; page++) {
      const res = await fetch(
        `${apiUrl}/repos/${org}/${repoName}/commits/${headSha}/check-runs?per_page=${GITHUB_PER_PAGE}&page=${page}`,
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
        total_count?: number;
        check_runs?: RawCheckRun[];
      };
      const pageRuns = body.check_runs ?? [];
      runs.push(...pageRuns);
      if (body.total_count !== undefined) {
        if (runs.length >= body.total_count) {
          reachedEnd = true;
          break;
        }
      } else if (pageRuns.length < GITHUB_PER_PAGE) {
        // No `total_count` (a proxy or non-canonical API): fall back to
        // page-size probing. A SHORT page is the end of the set; a FULL page
        // is not — inferring the total from the page length instead would make
        // page 1 look complete and defeat the truncation guard below.
        reachedEnd = true;
        break;
      }
    }
  } catch {
    return null;
  }
  if (runs.length === 0) {
    return null;
  }
  if (!reachedEnd) {
    // Truncated after GITHUB_MAX_PAGES pages — a partial view can't be
    // trusted to compute "complete"; fall back to legacy per-run signaling.
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

      // Atomic OPEN→MERGED guard, then signal, rolling back on failure — the
      // same shape as `resolveHitlStep` in `lib/hitlResolve.ts`, for the same
      // reason. The `status: 'OPEN'` predicate is the real concurrency guard
      // (the lookup above is an optimistic fast-path): two concurrent
      // deliveries of the same merge race here and only one updates a row.
      const merged = await fastify.prisma.pullRequest.updateMany({
        data: { status: 'MERGED' },
        where: { id: pullRequest.id, status: 'OPEN' },
      });
      if (merged.count === 0) {
        // Someone else won the race and is delivering the signal; a genuine
        // duplicate delivery no-ops here instead of signaling twice.
        return { data: { ignored: true, reason: 'PR already merged (duplicate delivery)' } };
      }

      // Signal the Temporal workflow. The workflow's merge wait only unblocks
      // via this signal, so a TRANSIENT failure after the row moved to MERGED
      // would strand it: a later delivery would no longer match the
      // `status: 'OPEN'` lookup and would be ignored. Roll the row back to OPEN
      // and answer non-2xx, which marks the delivery failed in GitHub's webhook
      // UI. GitHub does NOT retry a failed delivery on its own — recovery is a
      // human pressing "Redeliver" (or the CI/merge state being re-observed);
      // the rollback is what makes that redelivery able to work.
      //
      // A TERMINAL failure is the opposite case: the execution is gone (never
      // started, already completed, or terminated), so no redelivery can ever
      // land the signal and there is no run left to strand. Rolling back would
      // then record OPEN for a PR that IS merged on GitHub and invite an
      // endless redeliver-fail-redeliver loop that can never succeed. Keep
      // MERGED — recording the merge is the correct outcome — and answer 200.
      let signalSent = true;
      try {
        await fastify.temporal.signalWorkflow(
          pullRequest.workflow.temporalWorkflowId,
          'humanMergeSignal',
          [true]
        );
      } catch (err: unknown) {
        if (!isTerminalSignalError(err)) {
          request.log.error(
            { err, prNumber, prRowId: pullRequest.id },
            'Merge Temporal signal failed; rolling PR back to OPEN'
          );
          await fastify.prisma.pullRequest
            .updateMany({
              data: { status: 'OPEN' },
              where: { id: pullRequest.id, status: 'MERGED' },
            })
            .catch((rollbackErr: unknown) => {
              request.log.error(
                { err: rollbackErr, prRowId: pullRequest.id },
                'Merge rollback failed — PR stuck MERGED without a delivered signal'
              );
            });
          return reply.status(503).send({
            error: {
              code: 'SIGNAL_FAILED',
              message: 'Could not deliver the merge signal to the workflow — retry the delivery',
            },
          });
        }
        signalSent = false;
        request.log.warn(
          { err, prNumber, prRowId: pullRequest.id },
          'Merge signal target workflow no longer exists; keeping PR MERGED'
        );
      }

      // P0 evals: capture the human merge label as a normalized signal,
      // resolving the WorkflowRun by workflowId (there is no direct PR→Run FK).
      // Best-effort — wrapped so it can never block the merge signal path. Note:
      // close-without-merge (the reject label) is not yet captured; the PR event
      // normalizer maps those to `ignored`. Capturing rejects (to avoid
      // survivorship bias in calibration) is a follow-up — see docs/evals-p0.md.
      try {
        const evalRun = await fastify.prisma.workflowRun.findFirst({
          select: { id: true },
          where: { workflowId: pullRequest.workflow.temporalWorkflowId },
        });
        if (evalRun) {
          await fastify.prisma.evalResult.create({
            data: {
              metadata: { prNumber },
              passed: true,
              runId: evalRun.id,
              scorer: 'merge',
              scoreType: 'BOOLEAN',
              source: 'MERGE',
              value: 1,
            },
          });
        }
      } catch {
        // capture must never break the merge signal path
      }

      // Best-effort Slack "merged" notification back to the originating channel.
      const wr = pullRequest.workflow.workRequest;
      const originChannel = wr?.slackChannelId ?? null;
      const teamChannel = pullRequest.workflow.repository?.team?.slackNotifyChannel ?? null;
      const slackChannel = originChannel ?? teamChannel;
      if (slackChannel) {
        const botToken = await resolveSlackBotTokenForSlackChannel(slackChannel);
        await postSlackMessage(
          {
            channel: slackChannel,
            text: `:merged: *[${wr?.externalTicketId ?? 'unknown'}]* PR #${prNumber} was merged`,
            ...(originChannel && wr?.slackMessageTs ? { threadTs: wr.slackMessageTs } : {}),
          },
          botToken ?? undefined
        ).catch(() => null);
      }

      // Best-effort tracker sync on PR merge.
      if (wr?.externalTicketId) {
        const trackerConfig = await resolveIssueTrackerConfig();
        const { baseUrl: ghBaseUrl } = await resolveGitHubConfig();
        const prUrl = `${ghBaseUrl}/${org}/${repoName}/pull/${prNumber}`;
        await syncTrackerOnEvent(
          {
            issueId: wr.externalTicketId,
            prTitle: `PR #${prNumber}`,
            prUrl,
            type: 'workflow_completed',
          },
          trackerConfig
        ).catch(() => null);
      }

      return {
        data: {
          signalSent,
          workflowId: pullRequest.workflow.temporalWorkflowId,
          ...(signalSent ? {} : { reason: 'Workflow no longer running; merge recorded only' }),
        },
      };
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
        include: {
          workflow: {
            include: {
              workRequest: { select: { externalTicketId: true } },
            },
          },
        },
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

      // Batch-update CI status in a single transaction to avoid N+1 queries.
      //
      // The guard is a FRESHNESS check, not a change detector. A row only
      // transitions while it is still `PENDING` *at the head SHA this delivery
      // describes*:
      //
      //   • `ciStatus: 'PENDING'` means no verdict has been delivered for the
      //     current head yet. `createOrUpdatePullRequest` re-arms it to PENDING
      //     every time the worker pushes a new head, so exactly one verdict is
      //     signaled per CI wait.
      //   • `headSha` pins the write to the commit this delivery is about,
      //     closing the read-then-write race where the worker advances the PR
      //     to a new head between the lookup above and this update.
      //
      // A `ciStatus: { not: newStatus }` predicate would only detect *change*,
      // which lets a stale delivery replay over a newer verdict: a `failure`
      // whose signal failed, redelivered by hand after a later `success`
      // already resolved the wait, would flip PASSED back to FAILED and
      // re-signal `passed:false` (with stale logs) into a run that moved on.
      const newStatus = passed ? 'PASSED' : 'FAILED';
      const updateCounts = await fastify.prisma.$transaction(
        pullRequests.map((pr: (typeof pullRequests)[number]) =>
          fastify.prisma.pullRequest.updateMany({
            data: { ciStatus: newStatus },
            where: { ciStatus: 'PENDING', headSha, id: pr.id },
          })
        )
      );
      const transitioned = pullRequests.filter((_, i) => updateCounts[i].count === 1);

      if (transitioned.length === 0) {
        // Nothing was waiting on this commit's CI: the verdict for this head
        // was already delivered (or the PR has moved to a newer head). This
        // covers both a redelivery of an event already handled and a genuinely
        // new check-run event that concluded after the wait was resolved —
        // neither may signal, so both are dropped, but they are logged rather
        // than silently discarded.
        request.log.info(
          { conclusion, headSha, prRowIds: pullRequests.map((pr) => pr.id) },
          'CI check-run event dropped: no PR is awaiting a verdict at this commit'
        );
        return {
          data: {
            conclusion,
            ignored: true,
            reason: 'CI verdict already recorded for this commit',
          },
        };
      }

      // Signal all affected Temporal workflows in parallel.
      //
      // Partial-failure semantics (one check_run event can fan out to several
      // workflows): recovery is decided PER PR, not per delivery. A PR whose
      // signal failed TRANSIENTLY has its `ciStatus` rolled back to PENDING —
      // the value the guard above proved it held — so a redelivery of this
      // event transitions it again and re-signals. A PR whose signal succeeded
      // keeps the new status, so the same redelivery finds count 0 for it and
      // does NOT signal it a second time — the CI-wait step is not idempotent
      // on the workflow side, and a duplicate `ciPipelineSignal` could resume a
      // run that has already moved on. The handler then answers non-2xx, which
      // marks the delivery failed in GitHub's webhook UI; GitHub does NOT retry
      // it automatically, so recovery is a human pressing "Redeliver" — the
      // rollback is what makes that redelivery work. Retrying inline would
      // block the webhook.
      //
      // A PR whose signal failed TERMINALLY (execution gone: completed,
      // terminated, or never started) is neither rolled back nor counted
      // towards the non-2xx: no redelivery could ever land that signal, so
      // inviting one would only produce a loop that repeatedly rewrites
      // `ciStatus` for a run that no longer exists.
      type TrackedPr = (typeof transitioned)[number];
      const toSignal: Array<{ pr: TrackedPr; workflowId: string }> = [];
      for (const pr of transitioned) {
        if (pr.workflow) {
          toSignal.push({ pr, workflowId: pr.workflow.temporalWorkflowId });
        }
      }
      const results = await Promise.allSettled(
        toSignal.map((t) =>
          fastify.temporal.signalWorkflow(t.workflowId, 'ciPipelineSignal', [{ logsUrl, passed }])
        )
      );

      const signaled: string[] = [];
      const succeeded: TrackedPr[] = [];
      const failed: TrackedPr[] = [];
      results.forEach((r, i) => {
        const { pr, workflowId } = toSignal[i];
        if (r.status === 'rejected') {
          if (isTerminalSignalError(r.reason)) {
            request.log.warn(
              { err: r.reason, prRowId: pr.id, workflowId },
              'CI signal target workflow no longer exists; keeping the recorded ciStatus'
            );
            return;
          }
          request.log.error(
            { err: r.reason, prRowId: pr.id, workflowId },
            'Failed to signal workflow; rolling ciStatus back for redelivery'
          );
          failed.push(pr);
        } else {
          succeeded.push(pr);
          signaled.push(workflowId);
        }
      });

      if (failed.length > 0) {
        // Revert only the rows whose signal failed transiently, guarded on the
        // status AND the head SHA this delivery wrote, so a concurrent CI event
        // or a worker push to a new head is never clobbered. The restored value
        // is PENDING rather than the row read at the top of the handler: the
        // transition guard already proved the row was PENDING, while the read
        // may be stale.
        await Promise.all(
          failed.map((pr) =>
            fastify.prisma.pullRequest
              .updateMany({
                data: { ciStatus: 'PENDING' },
                where: { ciStatus: newStatus, headSha, id: pr.id },
              })
              .catch((rollbackErr: unknown) => {
                request.log.error(
                  { err: rollbackErr, prRowId: pr.id },
                  'CI status rollback failed — PR stuck without a delivered signal'
                );
              })
          )
        );
      }

      // Best-effort tracker sync on CI result — only for PRs whose signal
      // landed; a rolled-back PR syncs on its redelivery instead.
      const trackerConfig = await resolveIssueTrackerConfig();
      for (const pr of succeeded) {
        const ticketId = pr.workflow?.workRequest?.externalTicketId;
        if (ticketId) {
          await syncTrackerOnEvent(
            passed
              ? { issueId: ticketId, type: 'ci_passed' }
              : { issueId: ticketId, summary: `CI ${conclusion}`, type: 'ci_failed' },
            trackerConfig
          ).catch(() => null);
        }
      }

      if (failed.length > 0) {
        return reply.status(503).send({
          error: {
            code: 'SIGNAL_FAILED',
            message: `Could not deliver the CI signal to ${failed.length} of ${toSignal.length} workflow(s) — retry the delivery`,
          },
        });
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
    {
      schema: {
        body: z.record(z.string(), z.unknown()).optional(),
        headers: IdempotencyHeaderSchema,
        params: TriggerParams,
      },
    },
    async (request, reply) => {
      const { token } = request.params;
      const template = await fastify.prisma.workflowTemplate.findUnique({
        include: {
          team: {
            include: {
              organization: { select: { id: true, monthlyBudgetUsdCents: true } },
            },
          },
        },
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
        return reply.status(409).send({
          error: { code: 'NO_ACTIVE_VERSION', message: 'Template has no active version' },
        });
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
      const connectionId = typeof payload.connectionId === 'string' ? payload.connectionId : null;
      const description = typeof payload.description === 'string' ? payload.description : '';
      const workRequestId = crypto.randomUUID();
      // Correlation key, not a ticket — see the note on the template-run route.
      const externalTicketId =
        typeof payload.ticketId === 'string' ? payload.ticketId : workRequestId;
      const shortTplId = template.id.replace(/-/g, '').slice(0, 8);
      // An Idempotency-Key makes the ID a pure function of the key, so a sender
      // that retries (or fires twice) collapses onto one run instead of two.
      // Without one, every delivery is a distinct run — the previous behaviour.
      const idempotencyKey = request.headers['idempotency-key'];
      const temporalWorkflowId = idempotencyKey
        ? workflowIdFromIdempotencyKey('wh', shortTplId, idempotencyKey)
        : `wh-${shortTplId}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

      const providerMeta =
        template.workspaceProvider && isWorkspaceProviderType(template.workspaceProvider)
          ? getWorkspaceProviderMetadata(template.workspaceProvider)
          : null;

      const connectionResult = await validateRunConnection(
        {
          connectionId,
          prisma: fastify.prisma,
          providerMeta,
          templateTeamId: template.teamId,
          user: null,
        },
        reply
      );
      if (!connectionResult.ok) {
        return;
      }
      const budgetOrgId = connectionResult.budgetOrgId ?? template.team?.organization?.id;
      const budgetCap =
        connectionResult.budgetCap ?? template.team?.organization?.monthlyBudgetUsdCents;

      if (budgetOrgId && !(await assertOrgBudget(fastify.prisma, budgetOrgId, budgetCap, reply))) {
        return;
      }

      // Ledger rows first, workflow second, rolled back if the start fails —
      // see `launchTrackedWorkflow`.
      const templateVersion = template.activeVersion;
      const launch = await launchTrackedWorkflow(
        fastify.prisma,
        {
          activeWorkflow: {
            budgetTier: 'STANDARD',
            currentStatus: 'IMPLEMENTING',
            repoId: connectionId ?? null,
            temporalWorkflowId,
            workRequestId,
          },
          runInput: {
            connectionId,
            description,
            externalTicketId,
            id: workRequestId,
            payload: payload as object,
            requestedById: null,
            requestPayload: JSON.stringify(payload),
            templateId: template.id,
            templateVersion,
          },
        },
        () =>
          fastify.temporal.startRunnableWorkflow(temporalWorkflowId, {
            request: {
              budgetTier: 'STANDARD',
              connectionId,
              description,
              externalTicketId,
              payload,
              repoId: connectionId,
              requestPayload: JSON.stringify(payload),
              workRequestId,
            },
            templateId: template.id,
            templateVersion,
          }),
        { log: fastify.log }
      );
      if (!launch.ok) {
        return reply.status(409).send({
          error: {
            code: 'RUN_CONFLICT',
            message: 'A run with this workflow ID already exists',
          },
        });
      }

      return reply.status(201).send({
        data: { temporalWorkflowId, workflowId: launch.activeWorkflowId, workRequestId },
      });
    }
  );

  // POST /api/v1/webhooks/jira — receives Jira issue transition events and auto-creates work requests
  fastify.post(
    '/jira',
    {
      config: { rawBody: true, skipAuth: true },
      schema: { body: z.object({}).passthrough() },
    },
    async (request, reply) => {
      // 1. Verify HMAC-SHA256 signature — fail closed. No configured secret
      // means the webhook can't be authenticated at all, so (mirroring /git
      // and /ci) it is rejected rather than silently accepted.
      const config = await resolveIssueTrackerConfig();
      if (!config.webhookSecret) {
        return reply.code(401).send({ error: 'Jira webhook secret not configured' });
      }
      const signature = request.headers['x-hub-signature-256'] as string | undefined;
      if (!signature) {
        return reply.code(401).send({ error: 'Missing signature' });
      }
      const rawBody = (request as FastifyRequest & { rawBody?: string | Buffer }).rawBody;
      if (!rawBody) {
        return reply.code(401).send({ error: 'Missing raw body' });
      }
      if (!verifyGitHubSignature(rawBody, signature, config.webhookSecret)) {
        return reply.code(401).send({ error: 'Invalid signature' });
      }

      // 2. Parse the Jira webhook payload
      const payload = request.body as Record<string, unknown>;
      const issue = payload?.issue as Record<string, unknown> | undefined;
      const transition = payload?.transition as Record<string, unknown> | undefined;
      if (!issue || !transition) {
        return reply.code(200).send({ skipped: true }); // not an issue transition event
      }

      // 3. Check if the transition matches webhookTriggerStatus
      const triggerStatus = config.webhookTriggerStatus;
      const toStatus = (transition?.to as Record<string, unknown> | undefined)?.name as
        | string
        | undefined;
      if (!triggerStatus || !toStatus) {
        return reply.code(200).send({ skipped: true });
      }
      if (toStatus.toLowerCase() !== triggerStatus.toLowerCase()) {
        return reply.code(200).send({ skipped: true });
      }

      // 4. Auto-create a work request — find the first active git_repo connection
      const ticketId = issue.key as string | undefined;
      if (!ticketId) {
        return reply.code(200).send({ reason: 'missing issue key', skipped: true });
      }
      const fields = issue.fields as Record<string, unknown> | undefined;
      const summary = (fields?.summary as string | undefined) ?? ticketId;
      // Resolve the default repo + workflow template in parallel — they're
      // independent lookups, so the RunInput is processable without paying two
      // sequential round trips. These use the module-level `prisma`, which is
      // NOT `fastify.prisma`: the latter carries the `tenantGuard` extension.
      // Both reads are single-row `findFirst`s, which the guard does not cover
      // anyway, so the two are equivalent here — but they are no longer the
      // same client, and a multi-row query added below would escape the guard.
      const [defaultRepo, defaultTemplate] = await Promise.all([
        prisma.connection.findFirst({ where: { isActive: true, type: 'git_repo' } }),
        prisma.workflowTemplate.findFirst({ where: { isDefault: true, status: 'ACTIVE' } }),
      ]);
      if (!defaultRepo) {
        return reply.code(200).send({ reason: 'no active repos', skipped: true });
      }
      if (!defaultTemplate || defaultTemplate.activeVersion == null) {
        return reply.code(200).send({ reason: 'no active default template', skipped: true });
      }
      const templateVersion = defaultTemplate.activeVersion;

      const requestPayload = JSON.stringify({ source: 'jira_webhook', summary, ticketId });
      const workRequestId = crypto.randomUUID();
      // Deterministic Temporal workflow ID keyed by ticket so a redelivered
      // transition webhook collides on WorkflowExecutionAlreadyStartedError
      // instead of starting a second run — this makes the auto-trigger a
      // once-ever action per ticket. Re-triggering the same ticket after
      // completion requires resubmission via the authenticated path (POST
      // /work-requests or /webhooks/:token), which always allocates a fresh
      // workflow ID; this is deliberate.
      const temporalWorkflowId = `jira-${ticketId}`;

      // Ledger rows first, workflow second, rolled back if the start fails —
      // see `launchTrackedWorkflow`. Because the workflow ID is deterministic
      // (`jira-<ticket>`), the unique index on `temporalWorkflowId` is what
      // makes the auto-trigger once-ever per ticket; that dedup now also
      // outlives Temporal's execution-retention window.
      const launch = await launchTrackedWorkflow(
        prisma,
        {
          activeWorkflow: {
            budgetTier: 'STANDARD',
            currentStatus: 'IMPLEMENTING',
            repoId: defaultRepo.id,
            temporalWorkflowId,
            workRequestId,
          },
          runInput: {
            connectionId: defaultRepo.id,
            description: summary,
            externalTicketId: ticketId,
            id: workRequestId,
            requestPayload,
            templateId: defaultTemplate.id,
            templateVersion,
          },
        },
        () =>
          fastify.temporal.startRunnableWorkflow(temporalWorkflowId, {
            request: {
              budgetTier: 'STANDARD',
              description: summary,
              externalTicketId: ticketId,
              repoId: defaultRepo.id,
              requestPayload,
              workRequestId,
            },
            templateId: defaultTemplate.id,
            templateVersion,
          }),
        { log: fastify.log }
      );
      if (!launch.ok) {
        return reply.code(200).send({ duplicate: true, ok: true, ticketId });
      }

      return reply.code(200).send({ ok: true, ticketId });
    }
  );
};
