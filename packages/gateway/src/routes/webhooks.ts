import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { repositoryHostsAllowed } from '@auto-swe/shared/lib/connectionCredential';
import { resolvePlatformCredential } from '@auto-swe/shared/lib/githubHostCredential';
import { installationTargetFor } from '@auto-swe/shared/lib/githubHostScope';
import { resolveGitHubToken } from '@auto-swe/shared/lib/githubInstallation';
import { isInputSchema, validateInputPayload } from '@auto-swe/shared/lib/inputSchema';
import { clampPullRequestTitle } from '@auto-swe/shared/lib/pullRequest';
import {
  resolveGitHubConfig,
  resolveIssueTrackerConfig,
  resolveSlackBotTokenForSlackChannel,
} from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { syncTrackerOnEvent } from '@auto-swe/shared/lib/trackerSync';
import {
  getWorkspaceProviderMetadata,
  isWorkspaceProviderType,
  type WorkspaceProviderType,
} from '@auto-swe/shared/lib/workspaceProviders';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GITHUB_MAX_PAGES, GITHUB_PER_PAGE, verifyGitHubSignature } from '../lib/github.js';
import { resolveWebhookSecret } from '../lib/githubWebhookSecret.js';
import { sendError } from '../lib/httpErrors.js';
import { IdempotencyHeaderSchema, workflowIdFromIdempotencyKey } from '../lib/idempotency.js';
import { applyInstallationEvent, INSTALLATION_EVENT_TYPES } from '../lib/installationWebhook.js';
import { assertOrgBudget } from '../lib/orgAccess.js';

const JiraWebhookSchema = z
  .object({
    issue: z
      .object({
        fields: z.record(z.string(), z.unknown()).optional(),
        key: z.string(),
      })
      .optional(),
    transition: z
      .object({
        to: z.object({ name: z.string() }),
      })
      .optional(),
  })
  .passthrough();

import {
  claimsHostWithOwnSecret,
  deliveryHostMatches,
  webhookRepositoryWhere,
} from '../lib/repositoryHost.js';
import { validateRunConnection } from '../lib/runConnection.js';
import { postSlackMessage } from '../lib/slack.js';
// The webhook handlers below undo their DB write and answer non-2xx when a
// signal fails, so the delivery can be sent again — only ever useful for a
// TRANSIENT failure. See `lib/temporalErrors.ts` for why a terminal one keeps
// the write and answers 2xx instead.
import { isTerminalSignalError } from '../lib/temporalErrors.js';
import { isValidTicketId } from '../lib/ticketId.js';
import { launchTrackedWorkflow } from '../lib/workflowLaunch.js';
import { resolveDefaultTemplate } from './workRequests.js';

// GitHub payloads are HMAC-verified before we get here, but a shape change or a
// non-PR/non-check event can still arrive. Validate the fields we touch so a
// malformed-but-signed body is ignored gracefully instead of throwing a 500.
const PullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    closed_at: z.string().nullish(),
    merged: z.boolean(),
    merged_at: z.string().nullish(),
    number: z.number(),
    title: z.string().optional(),
  }),
  // `html_url` carries the host `full_name` lacks; optional so a payload
  // without it still matches by name, as before.
  repository: z.object({ full_name: z.string(), html_url: z.string().optional() }),
});

const CheckRunWebhookSchema = z.object({
  action: z.string(),
  check_run: z
    .object({ conclusion: z.string(), head_sha: z.string(), html_url: z.string() })
    .optional(),
  repository: z.object({ full_name: z.string(), html_url: z.string().optional() }),
});

// ── GitHub payload → domain-event normalization ──
//
// The route handlers below operate on these provider-agnostic events; only
// the normalize functions know GitHub's payload shapes. A future GitLab
// webhook route maps its own payloads to the same event types and reuses the
// downstream DB-update + Temporal-signal logic unchanged.

/** Where a PR event happened: the repository and the PR's number in it. */
interface PullRequestRef {
  prNumber: number;
  org: string;
  repoName: string;
  /** The repository's web URL, which names its host. */
  repoHtmlUrl?: string;
}

/**
 * A PR domain event extracted from a provider webhook payload. Only a merge
 * signals the workflow; the rest record how the PR moved on its host.
 */
export type PullRequestEvent =
  /** Payload didn't match the expected shape at all. */
  | { type: 'unrecognized' }
  /** Valid payload but not a lifecycle change we track (opened, synchronize, ...). */
  | { type: 'ignored' }
  | ({ type: 'merged'; mergedAt: Date } & PullRequestRef)
  /** Closed without merging. */
  | ({ type: 'closed'; closedAt: Date } & PullRequestRef)
  | ({ type: 'reopened' } & PullRequestRef)
  | ({ type: 'draft'; isDraft: boolean } & PullRequestRef)
  | ({ type: 'retitled'; title: string } & PullRequestRef);

/** A CI check-completion domain event extracted from a provider webhook payload. */
export type CheckRunCompletedEvent =
  | { type: 'unrecognized' }
  /** Valid payload but not a completed check run. */
  | { type: 'ignored' }
  | {
      type: 'completed';
      org: string;
      repoName: string;
      /** The repository's web URL, which names its host. */
      repoHtmlUrl?: string;
      headSha: string;
      conclusion: string;
      logsUrl: string;
    };

/** The host's timestamp when it sent a usable one, else now. */
function eventTime(iso: string | null | undefined): Date {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? at : new Date();
}

/** Pure mapping from a GitHub `pull_request` webhook body to a domain event. */
export function normalizeGitHubPullRequestEvent(body: unknown): PullRequestEvent {
  const parsed = PullRequestWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return { type: 'unrecognized' };
  }
  const payload = parsed.data;
  const pr = payload.pull_request;

  const [org, repoName] = payload.repository.full_name.split('/');
  const ref: PullRequestRef = {
    org,
    prNumber: pr.number,
    repoHtmlUrl: payload.repository.html_url,
    repoName,
  };
  switch (payload.action) {
    case 'closed':
      return pr.merged
        ? { ...ref, mergedAt: eventTime(pr.merged_at), type: 'merged' }
        : { ...ref, closedAt: eventTime(pr.closed_at), type: 'closed' };
    case 'reopened':
      return { ...ref, type: 'reopened' };
    case 'ready_for_review':
      return { ...ref, isDraft: false, type: 'draft' };
    case 'converted_to_draft':
      return { ...ref, isDraft: true, type: 'draft' };
    case 'edited': {
      const title = clampPullRequestTitle(pr.title);
      return title ? { ...ref, title, type: 'retitled' } : { type: 'ignored' };
    }
    default:
      return { type: 'ignored' };
  }
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
    repoHtmlUrl: payload.repository.html_url,
    repoName,
    type: 'completed',
  };
}

/**
 * `host` is the host the verifying secret proves: the per-host row's host, or
 * null when the instance secret verified. Handlers must bind the delivery to it
 * (`lib/repositoryHost.ts`) — a secret proves who sent a payload, not which
 * repository the payload may act on.
 */
type VerifiedWebhook = { ok: true; host: string | null } | { ok: false };

/** The ignored response for a payload naming a repository on another host. */
const HOST_MISMATCH = {
  data: { ignored: true, reason: 'Repository is not on the host that signed this delivery' },
};

async function verifyWebhookOrReject(
  request: FastifyRequest & { rawBody?: string | Buffer },
  reply: FastifyReply
): Promise<VerifiedWebhook> {
  const signature = request.headers['x-hub-signature-256'] as string;
  const resolved = await resolveWebhookSecret(
    request.server.prisma,
    request.headers['x-github-enterprise-host']
  );

  if (resolved.status === 'host_not_approved') {
    // Not the instance secret's to answer for: a host that lost its approval
    // verifies nothing.
    reply.status(401).send({
      error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Webhook host is not an approved host' },
    });
    return { ok: false };
  }

  const { host, secret } = resolved;
  if (!secret || !signature) {
    reply
      .status(401)
      .send({ error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Missing signature' } });
    return { ok: false };
  }

  if (!request.rawBody) {
    reply.status(400).send({ error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Missing raw body' } });
    return { ok: false };
  }

  if (!verifyGitHubSignature(request.rawBody, signature, secret)) {
    reply
      .status(401)
      .send({ error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Invalid signature' } });
    return { ok: false };
  }

  return { host, ok: true };
}

/**
 * Where, and with which credential, to ask GitHub about a tracked repository.
 *
 * The API of the host the repository lives on, with a token from that host's
 * platform credential set — the instance's for an instance repository, the
 * host's own for a repository on another approved host — minted for the
 * repository's installation (else the set's singleton one). Applies the same
 * shared rule as the worker (`resolvePlatformCredential`): no platform
 * credential (PAT, App JWT, installation token) goes to a host it does not
 * belong to, whatever installation the repository records; and a repository
 * whose web and API hosts differ gets none either. Never a user's token: a
 * webhook has no launcher.
 *
 * Null (aggregation unavailable, so the caller signals per run) when the
 * repository's URL overrides are not on an approved host — no credential is
 * minted for them — when its host has no platform credential, or when no
 * credential can be resolved.
 */
async function checkRunTarget(
  repo:
    | {
        githubApiUrl: string | null;
        githubUrl: string | null;
        installation: { installationId: string; host: string } | null;
      }
    | null
    | undefined,
  log: FastifyRequest['log']
): Promise<{ apiUrl: string; token: string } | null> {
  const ghConfig = await resolveGitHubConfig();
  const apiUrl = repo?.githubApiUrl ?? ghConfig.apiUrl;
  if (repo) {
    const hosts = await repositoryHostsAllowed({
      githubApiUrl: repo.githubApiUrl,
      githubUrl: repo.githubUrl,
    });
    if (!hosts.ok) {
      log.warn({ url: hosts.url }, 'repository host is not approved; no credential sent');
      return null;
    }
  }
  // The shared rule (`githubHostScope`), the same one the worker applies: a
  // platform credential never leaves the host it belongs to, and a repository's
  // web and API hosts must agree.
  const scoped = {
    apiUrl: repo?.githubApiUrl,
    baseUrl: repo?.githubUrl,
    installationHost: repo?.installation?.host ?? null,
    installationId: repo?.installation?.installationId ?? null,
  };
  try {
    const credential = await resolvePlatformCredential(scoped, ghConfig);
    if (credential.scope !== 'instance' && credential.scope !== 'host') {
      log.warn(
        { apiUrl, githubUrl: repo?.githubUrl, scope: credential.scope },
        "no platform credential is valid on this repository's host"
      );
      return null;
    }
    const target = installationTargetFor(scoped, credential.config);
    const token = await resolveGitHubToken(credential.config, target);
    return { apiUrl: target.apiUrl, token };
  } catch (err) {
    log.warn({ err }, 'no GitHub credential for the check-run lookup');
    return null;
  }
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

import { isInstallationRetired } from '@auto-swe/shared/lib/repoAccessDecision';
import { refreshInvalidatedAccess } from '../lib/repoAccessRefresh.js';
import { classifyAccessEvent } from '../lib/repoAccessWebhook.js';

const TriggerParams = z.object({ token: z.string().min(1) });

/**
 * Record how a tracked PR moved on its host. Updates the row the platform
 * already holds for (repository, number) and nothing else: a PR opened outside
 * the platform has no row and is not created here. Every write is a guarded
 * `updateMany`, so a redelivery that finds the row already changed is a no-op.
 */
async function recordPullRequestChange(
  fastify: FastifyInstance,
  event: Exclude<PullRequestEvent, { type: 'unrecognized' | 'ignored' | 'merged' }>,
  repositoryWhere: Prisma.ConnectionWhereInput
) {
  const row = await fastify.prisma.pullRequest.findFirst({
    select: { id: true },
    where: { prNumber: event.prNumber, repository: repositoryWhere },
  });
  if (!row) {
    return { ignored: true, reason: 'No tracked pull request' };
  }
  const where = { id: row.id };
  const result = await (() => {
    switch (event.type) {
      case 'closed':
        return fastify.prisma.pullRequest.updateMany({
          data: { closedAt: event.closedAt, status: 'CLOSED' },
          where: { ...where, status: 'OPEN' },
        });
      case 'reopened':
        return fastify.prisma.pullRequest.updateMany({
          data: { closedAt: null, status: 'OPEN' },
          where: { ...where, status: 'CLOSED' },
        });
      case 'draft':
        return fastify.prisma.pullRequest.updateMany({
          data: { isDraft: event.isDraft },
          where,
        });
      case 'retitled':
        return fastify.prisma.pullRequest.updateMany({ data: { title: event.title }, where });
    }
  })();
  return { updated: result.count > 0 };
}

export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/v1/webhooks/git
  fastify.post(
    '/git',
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      const verified = await verifyWebhookOrReject(request, reply);
      if (!verified.ok) {
        return;
      }

      // The App's own lifecycle events arrive on the same webhook URL.
      const eventType = request.headers['x-github-event'];
      if (typeof eventType === 'string' && INSTALLATION_EVENT_TYPES.has(eventType)) {
        return {
          data: await applyInstallationEvent(
            fastify,
            eventType,
            request.body,
            verified.host,
            request.headers['x-github-enterprise-host']
          ),
        };
      }

      const event = normalizeGitHubPullRequestEvent(request.body);
      if (event.type === 'unrecognized') {
        return { data: { ignored: true, reason: 'Unrecognized payload shape' } };
      }
      if (event.type === 'ignored') {
        return { data: { ignored: true } };
      }
      if (
        !deliveryHostMatches(verified.host, event.repoHtmlUrl) ||
        (await claimsHostWithOwnSecret(fastify.prisma, verified.host, event.repoHtmlUrl))
      ) {
        return HOST_MISMATCH;
      }

      const { org, prNumber, repoName } = event;
      const repositoryWhere = await webhookRepositoryWhere(
        fastify.prisma,
        org,
        repoName,
        event.repoHtmlUrl,
        verified.host
      );

      if (event.type !== 'merged') {
        return { data: await recordPullRequestChange(fastify, event, repositoryWhere) };
      }

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
          repository: repositoryWhere,
          // CLOSED too: a reopen that was lost or arrived late must not strand a merge.
          status: { in: ['OPEN', 'CLOSED'] },
        },
      });

      if (!pullRequest?.workflow) {
        return { data: { ignored: true, reason: 'No tracked workflow for this PR' } };
      }

      // Atomic OPEN|CLOSED→MERGED guard, then signal, rolling back on failure — the
      // same shape as `resolveHitlStep` in `lib/hitlResolve.ts`, for the same
      // reason. The status predicate is the real concurrency guard
      // (the lookup above is an optimistic fast-path): two concurrent
      // deliveries of the same merge race here and only one updates a row.
      const merged = await fastify.prisma.pullRequest.updateMany({
        data: { closedAt: event.mergedAt, mergedAt: event.mergedAt, status: 'MERGED' },
        where: { id: pullRequest.id, status: { in: ['OPEN', 'CLOSED'] } },
      });
      if (merged.count === 0) {
        // Someone else won the race and is delivering the signal; a genuine
        // duplicate delivery no-ops here instead of signaling twice.
        return { data: { ignored: true, reason: 'PR already merged (duplicate delivery)' } };
      }

      // Signal the Temporal workflow. The workflow's merge wait only unblocks
      // via this signal, so a TRANSIENT failure after the row moved to MERGED
      // would strand it: a later delivery would no longer match the
      // OPEN/CLOSED lookup and would be ignored. Roll the row back to its
      // previous status (OPEN or CLOSED) and answer non-2xx, which marks the delivery failed in GitHub's webhook
      // UI. GitHub does NOT retry a failed delivery on its own — recovery is a
      // human pressing "Redeliver" (or the CI/merge state being re-observed);
      // the rollback is what makes that redelivery able to work.
      //
      // A TERMINAL failure is the opposite case: the execution is gone (never
      // started, already completed, or terminated), so no redelivery can ever
      // land the signal and there is no run left to strand. Rolling back would
      // then record a pre-merge status for a PR that IS merged on GitHub and invite an
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
            'Merge Temporal signal failed; rolling PR back to its previous status'
          );
          await fastify.prisma.pullRequest
            .updateMany({
              data: {
                closedAt: pullRequest.closedAt,
                mergedAt: null,
                status: pullRequest.status,
              },
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
      } catch (err) {
        // capture must never break the merge signal path
        request.log.warn({ err }, 'eval-signal capture failed on PR merge (non-fatal)');
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
        ).catch((err: unknown) => {
          request.log.warn({ err }, 'Slack merge notification failed (non-fatal)');
          return null;
        });
      }

      // Best-effort tracker sync on PR merge.
      if (wr?.externalTicketId) {
        const trackerConfig = await resolveIssueTrackerConfig();
        // The repository's own web base, not the instance's: it may be on
        // another host.
        const webBase =
          pullRequest.workflow.repository?.githubUrl ?? (await resolveGitHubConfig()).baseUrl;
        const prUrl = `${webBase}/${org}/${repoName}/pull/${prNumber}`;
        await syncTrackerOnEvent(
          {
            issueId: wr.externalTicketId,
            prTitle: `PR #${prNumber}`,
            prUrl,
            type: 'workflow_completed',
          },
          trackerConfig
        ).catch((err: unknown) => {
          request.log.warn({ err }, 'tracker sync failed (non-fatal)');
          return null;
        });
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

  // POST /api/v1/webhooks/access
  //
  // Collaborator, team, org-membership and repository events. The scheduled
  // sweep bounds how long a stale permission answer can survive; this is what
  // makes revocation fast, so that the sweep interval is not itself the
  // revocation window an operator has to defend.
  fastify.post(
    '/access',
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      const verified = await verifyWebhookOrReject(request, reply);
      if (!verified.ok) {
        return;
      }

      const eventType = (request.headers['x-github-event'] as string | undefined) ?? '';
      if (INSTALLATION_EVENT_TYPES.has(eventType)) {
        return {
          data: await applyInstallationEvent(
            fastify,
            eventType,
            request.body,
            verified.host,
            request.headers['x-github-enterprise-host']
          ),
        };
      }
      const invalidation = classifyAccessEvent(eventType, request.body);
      if (invalidation.kind === 'ignored') {
        return { data: { ignored: true, reason: invalidation.reason } };
      }
      if (
        invalidation.kind !== 'user' &&
        (!deliveryHostMatches(verified.host, invalidation.htmlUrl) ||
          (await claimsHostWithOwnSecret(fastify.prisma, verified.host, invalidation.htmlUrl)))
      ) {
        return HOST_MISMATCH;
      }

      // Never fail the response on a lookup error. GitHub redelivers a non-2xx,
      // and one timed-out lookup turning into a redelivery storm is worse than
      // a pair that keeps its previous answer until the next sweep.
      try {
        const outcome = await refreshInvalidatedAccess(fastify.prisma, invalidation, verified.host);
        if (outcome.failed > 0) {
          request.log.warn(
            { eventType, ...outcome },
            'some permission lookups failed; previous answers left in place'
          );
        }
        return { data: outcome };
      } catch (err) {
        request.log.error({ err, eventType }, 'access webhook refresh failed');
        return { data: { failed: 0, refreshed: 0, skipped: 'refresh failed; see gateway logs' } };
      }
    }
  );

  // POST /api/v1/webhooks/ci
  fastify.post(
    '/ci',
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      const verified = await verifyWebhookOrReject(request, reply);
      if (!verified.ok) {
        return;
      }

      const event = normalizeGitHubCheckRunEvent(request.body);
      if (event.type === 'unrecognized') {
        return { data: { ignored: true, reason: 'Unrecognized payload shape' } };
      }
      if (event.type === 'ignored') {
        return { data: { ignored: true } };
      }
      if (
        !deliveryHostMatches(verified.host, event.repoHtmlUrl) ||
        (await claimsHostWithOwnSecret(fastify.prisma, verified.host, event.repoHtmlUrl))
      ) {
        return HOST_MISMATCH;
      }

      const { conclusion, headSha, org, repoName } = event;
      const repositoryWhere = await webhookRepositoryWhere(
        fastify.prisma,
        org,
        repoName,
        event.repoHtmlUrl,
        verified.host
      );

      // Find tracked PRs by commit SHA
      const pullRequests = await fastify.prisma.pullRequest.findMany({
        include: {
          // What the check-run lookup needs to decide whether the repository is
          // on the instance's host, and which installation to mint for.
          repository: {
            select: {
              githubApiUrl: true,
              githubUrl: true,
              id: true,
              installation: { select: { host: true, installationId: true } },
            },
          },
          workflow: {
            include: {
              workRequest: { select: { externalTicketId: true } },
            },
          },
        },
        where: {
          headSha,
          repository: repositoryWhere,
          status: 'OPEN',
        },
      });

      if (pullRequests.length === 0) {
        return { data: { ignored: true, reason: 'No tracked PR for this commit' } };
      }

      // A failing run decides the outcome on its own — signal immediately so
      // the CI-fix loop gets the failing logs without waiting for the rest.
      //
      // The verdict is per repository: the same SHA can be tracked on more than
      // one (a fork, a mirror, the same name on two hosts), and each is asked
      // about on its own host with its own credential, never one's answer for
      // another.
      type TrackedRow = (typeof pullRequests)[number];
      const verdictOf = new Map<string, { passed: boolean; logsUrl: string }>();
      const perRun = { logsUrl: event.logsUrl, passed: conclusion === 'success' };
      let awaiting = pullRequests;
      if (NON_FAILING_CONCLUSIONS.has(conclusion)) {
        // A passing run says nothing about the other checks on the SHA.
        // Aggregate and only signal once everything has completed.
        const byRepository = new Map<string, TrackedRow[]>();
        for (const pr of pullRequests) {
          const key = pr.repository?.id ?? '';
          byRepository.set(key, [...(byRepository.get(key) ?? []), pr]);
        }
        awaiting = [];
        for (const group of byRepository.values()) {
          const target = await checkRunTarget(group[0].repository, request.log);
          const aggregated = target
            ? await aggregateCheckRuns(target.apiUrl, target.token, org, repoName, headSha)
            : null;
          if (aggregated && !aggregated.complete) {
            continue;
          }
          let verdict = perRun;
          if (aggregated) {
            verdict = {
              logsUrl:
                !aggregated.passed && aggregated.failingLogsUrl
                  ? aggregated.failingLogsUrl
                  : perRun.logsUrl,
              passed: aggregated.passed,
            };
          } else {
            request.log.warn(
              { headSha, repoFullName: `${org}/${repoName}` },
              'check-run aggregation unavailable (no PAT or API error); signaling per run'
            );
          }
          for (const pr of group) {
            verdictOf.set(pr.id, verdict);
            awaiting.push(pr);
          }
        }
        if (awaiting.length === 0) {
          return {
            data: { conclusion, deferred: true, reason: 'Other check runs still in progress' },
          };
        }
      } else {
        for (const pr of pullRequests) {
          verdictOf.set(pr.id, perRun);
        }
      }
      const statusOf = (pr: TrackedRow) => (verdictOf.get(pr.id)?.passed ? 'PASSED' : 'FAILED');

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
      // A `ciStatus: { not: <the new status> }` predicate would only detect *change*,
      // which lets a stale delivery replay over a newer verdict: a `failure`
      // whose signal failed, redelivered by hand after a later `success`
      // already resolved the wait, would flip PASSED back to FAILED and
      // re-signal `passed:false` (with stale logs) into a run that moved on.
      const updateCounts = await fastify.prisma.$transaction(
        awaiting.map((pr: TrackedRow) =>
          fastify.prisma.pullRequest.updateMany({
            data: { ciStatus: statusOf(pr) },
            where: { ciStatus: 'PENDING', headSha, id: pr.id },
          })
        )
      );
      const transitioned = awaiting.filter((_, i) => updateCounts[i].count === 1);

      if (transitioned.length === 0) {
        // Nothing was waiting on this commit's CI: the verdict for this head
        // was already delivered (or the PR has moved to a newer head). This
        // covers both a redelivery of an event already handled and a genuinely
        // new check-run event that concluded after the wait was resolved —
        // neither may signal, so both are dropped, but they are logged rather
        // than silently discarded.
        request.log.info(
          { conclusion, headSha, prRowIds: awaiting.map((pr) => pr.id) },
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
        toSignal.map((t) => {
          const { logsUrl, passed } = verdictOf.get(t.pr.id) ?? perRun;
          return fastify.temporal.signalWorkflow(t.workflowId, 'ciPipelineSignal', [
            { logsUrl, passed },
          ]);
        })
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
                where: { ciStatus: statusOf(pr), headSha, id: pr.id },
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
            verdictOf.get(pr.id)?.passed
              ? { issueId: ticketId, type: 'ci_passed' }
              : { issueId: ticketId, summary: `CI ${conclusion}`, type: 'ci_failed' },
            trackerConfig
          ).catch((err: unknown) => {
            request.log.warn({ err }, 'tracker sync failed (non-fatal)');
            return null;
          });
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
      bodyLimit: 128 * 1024,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
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
          // No authenticated user, so no GitHub identity to check. This caller
          // is scoped to the template's own team instead.
          gate: undefined,
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
            ticketIsSynthetic: externalTicketId === workRequestId,
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
              workspaceProvider: template.workspaceProvider as WorkspaceProviderType | null,
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
      // Every acknowledgement is a 200 so Jira does not retry it; a skip says
      // why in the standard `{ data }` envelope.
      const skip = (reason: string) => reply.code(200).send({ data: { reason, skipped: true } });

      // 1. Verify HMAC-SHA256 signature — fail closed. No configured secret
      // means the webhook can't be authenticated at all, so (mirroring /git
      // and /ci) it is rejected rather than silently accepted.
      const config = await resolveIssueTrackerConfig();
      if (!config.webhookSecret) {
        return sendError(reply, 401, 'UNAUTHORIZED', 'Jira webhook secret not configured');
      }
      const signature = request.headers['x-hub-signature-256'] as string | undefined;
      if (!signature) {
        return sendError(reply, 401, 'UNAUTHORIZED', 'Missing signature');
      }
      const rawBody = (request as FastifyRequest & { rawBody?: string | Buffer }).rawBody;
      if (!rawBody) {
        return sendError(reply, 401, 'UNAUTHORIZED', 'Missing raw body');
      }
      if (!verifyGitHubSignature(rawBody, signature, config.webhookSecret)) {
        return sendError(reply, 401, 'UNAUTHORIZED', 'Invalid signature');
      }

      // 2. Parse the Jira webhook payload
      const parsed = JiraWebhookSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 422, 'VALIDATION_ERROR', 'Invalid Jira webhook payload', {
          issues: parsed.error.issues,
        });
      }
      const { issue, transition } = parsed.data;
      if (!issue || !transition) {
        return skip('not an issue transition event');
      }

      // 3. Check if the transition matches webhookTriggerStatus
      const triggerStatus = config.webhookTriggerStatus;
      const toStatus = transition.to.name;
      if (!triggerStatus || !toStatus) {
        return skip('no trigger status configured');
      }
      if (toStatus.toLowerCase() !== triggerStatus.toLowerCase()) {
        return skip('transition does not match the trigger status');
      }

      // 4. Auto-create a work request. The tracker config is a platform-wide
      // singleton with no ticket → repository mapping, so the trigger is only
      // unambiguous when exactly one active git repository is onboarded. With
      // several (a multi-team or multi-org deployment) picking "the first" would
      // route one tenant's tickets — and spend — into another tenant's repo, so
      // the transition is acknowledged and skipped instead.
      const ticketId = issue.key;
      // The key becomes the branch name and the Temporal workflow id, so it
      // takes the same validation as an authenticated submission.
      if (!isValidTicketId(ticketId)) {
        return skip('invalid ticket id');
      }
      const fields = issue.fields;
      const summary = (fields?.summary as string | undefined) ?? ticketId;
      const candidateRepos = await runUnscoped(
        'jira auto-trigger resolves the single onboarded repo',
        ['Connection'],
        () =>
          fastify.prisma.connection.findMany({
            include: {
              installation: { select: { isActive: true } },
              team: {
                select: { organization: { select: { monthlyBudgetUsdCents: true } }, orgId: true },
              },
            },
            take: 2,
            where: { isActive: true, type: 'git_repo' },
          })
      );
      if (candidateRepos.length === 0) {
        return skip('no active repos');
      }
      if (candidateRepos.length > 1) {
        fastify.log.warn(
          { ticketId },
          'Jira auto-trigger skipped: more than one active repository — submit via POST /work-requests or a template webhook instead'
        );
        return skip('ambiguous target repository');
      }
      const defaultRepo = candidateRepos[0];
      // This path starts a real run — a push and a pull request — without an
      // authenticated user, so it is exempt from the GitHub gate for want of an
      // identity. Retirement is not about identity, so that exemption does not
      // reach it.
      if (isInstallationRetired(defaultRepo)) {
        fastify.log.warn(
          { repoId: defaultRepo.id, ticketId },
          'Jira auto-trigger skipped: the GitHub App installation this repository uses has been retired'
        );
        return skip('installation retired');
      }
      // Team default first, then the global default — the same resolution (and
      // A/B bucketing) an authenticated submission for this repo would get,
      // instead of whichever team's default row Postgres returns first.
      const resolved = await resolveDefaultTemplate(fastify.prisma, defaultRepo.teamId, ticketId);
      const defaultTemplate = resolved
        ? await fastify.prisma.workflowTemplate.findUnique({ where: { id: resolved.templateId } })
        : null;
      if (!resolved || !defaultTemplate) {
        return skip('no active default template');
      }
      const templateVersion = resolved.version;
      // The run spends the repo's org budget exactly like an authenticated
      // submission would, so apply the same monthly cap.
      if (
        !(await assertOrgBudget(
          fastify.prisma,
          defaultRepo.team.orgId,
          defaultRepo.team.organization?.monthlyBudgetUsdCents,
          reply
        ))
      ) {
        return;
      }

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
        fastify.prisma,
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
              workspaceProvider: defaultTemplate.workspaceProvider as WorkspaceProviderType | null,
            },
            templateId: defaultTemplate.id,
            templateVersion,
          }),
        { log: fastify.log }
      );
      if (!launch.ok) {
        return reply.code(200).send({ data: { duplicate: true, ticketId } });
      }

      return reply.code(200).send({ data: { duplicate: false, ticketId } });
    }
  );
};
