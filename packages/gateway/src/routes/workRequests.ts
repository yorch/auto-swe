import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { shouldRouteToCanary } from '@auto-swe/shared/lib/canary';
import { isGitRepoConnection } from '@auto-swe/shared/lib/connectionGuards';
import { isInputSchema, validateInputPayload } from '@auto-swe/shared/lib/inputSchema';
import { extractFigmaRefs } from '@auto-swe/shared/lib/integrations/figmaDesign';
import {
  createFigmaDesignProvider,
  createKnowledgeBaseProvider,
} from '@auto-swe/shared/lib/integrations/registry';
import { repoMembersSelect } from '@auto-swe/shared/lib/repoMembership';
import { confirmInFlight, liveInFlightExecution } from '@auto-swe/shared/lib/requestInFlight';
import {
  resolveCanaryConfig,
  resolveFigmaConfig,
  resolveIssueTrackerConfig,
  resolveKnowledgeBaseConfig,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import {
  generateBranchName,
  generateWorkflowId,
  legacyWorkflowIdBases,
} from '@auto-swe/shared/lib/workflowId';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { experimentBucket } from '../lib/experimentBucket.js';
import { IdempotencyHeaderSchema } from '../lib/idempotency.js';
import { fetchTicket } from '../lib/issueTrackerClient.js';
import { authorizeLaunch, sendLaunchRefusal } from '../lib/launchAuthorization.js';
import {
  assertMcpWriteAllowed,
  mcpWriteAuditHook,
  mcpWriteBegin,
  sendRunCapRefusal,
} from '../lib/mcpWriteGuard.js';
import { paginationQuery } from '../lib/pagination.js';
import { retryTemplateRequest } from '../lib/retryTemplateRequest.js';
import { isSystemTemplate } from '../lib/systemTemplate.js';
import {
  inputsSatisfySchema,
  launchableTemplateWhere,
  sendTemplateNotLaunchable,
} from '../lib/templateLaunch.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { ExternalTicketIdSchema, MAX_DESCRIPTION_LENGTH } from '../lib/ticketId.js';
import { allocateWorkflowId, launchTrackedWorkflow } from '../lib/workflowLaunch.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Deterministic canary routing decision (Evals P2). Returns the pinned candidate
 * agent version when `key` hashes into the canary bucket, else undefined. Never
 * throws — a config failure means "no canary" and must never block submission.
 * Called with the same `key` (the work-request id) on both the submit and re-run
 * paths so a request always routes to the same arm.
 */
async function resolveCanaryPin(
  key: string
): Promise<{ canaryAgentKey: string; canaryVersion: number } | undefined> {
  try {
    const cfg = await resolveCanaryConfig();
    if (
      cfg.enabled &&
      cfg.agentKey &&
      cfg.candidateVersion != null &&
      shouldRouteToCanary(key, {
        agentKey: cfg.agentKey,
        candidateVersion: cfg.candidateVersion,
        percent: cfg.percent,
      })
    ) {
      return { canaryAgentKey: cfg.agentKey, canaryVersion: cfg.candidateVersion };
    }
  } catch {
    // non-fatal: canary config failure never blocks submission
  }
  return undefined;
}

/**
 * Best-effort ticket enrichment (EVOL-5): when a tracker connector is
 * configured, fetch the external ticket and seed `ContextSnapshot.rawTicketData`
 * for the work request. When a knowledge base connector is also configured,
 * fetches linked pages and seeds `ContextSnapshot.rawDocumentation`.
 *
 * The worker's `validateContext` activity later upserts the same row
 * (unique on workRequestId) but only writes `successCriteria` on the update
 * path, so the ticket payload survives.
 *
 * Nothing reads `rawTicketData` or `rawDocumentation` yet, so this runs after
 * the 201 rather than in front of it. Never throws — every failure is logged
 * and swallowed.
 */
async function enrichWithTicketData(
  fastify: FastifyInstance,
  args: {
    externalTicketId: string;
    repo: { organizationName: string; repoName: string };
    workRequestId: string;
  }
): Promise<string> {
  try {
    const tracker = await resolveIssueTrackerConfig();

    if (!tracker.provider) {
      return '';
    }

    // Resolve KB config independently so a missing/broken KB table never
    // aborts ticket enrichment (which is the more critical path).
    const kbConfig = await resolveKnowledgeBaseConfig().catch((err: unknown) => {
      fastify.log.warn({ err }, 'KB config resolution failed; enriching without knowledge base');
      return null;
    });

    const ticket = await fetchTicket(tracker, args.externalTicketId, {
      defaultRepo: { owner: args.repo.organizationName, repo: args.repo.repoName },
      fetchLinkedPages: kbConfig?.enabled ?? false,
      log: fastify.log,
    });
    if (!ticket) {
      return '';
    }

    // Best-effort: fetch linked KB pages when a knowledge base is configured
    // and the ticket references page IDs (Jira + Confluence).
    let rawDocumentation: unknown = null;
    if (kbConfig?.enabled && kbConfig.provider) {
      try {
        const kbProvider = createKnowledgeBaseProvider(kbConfig, { log: fastify.log });
        if (kbProvider) {
          const linkedPageIds = (ticket.raw as { linkedPageIds?: string[] })?.linkedPageIds;
          if (Array.isArray(linkedPageIds) && linkedPageIds.length > 0) {
            const pages = await kbProvider.fetchLinkedPages(linkedPageIds);
            if (pages.length > 0) {
              rawDocumentation = pages;
            }
          } else if (kbConfig?.spaces?.length) {
            // Fallback: search by ticket ID in configured spaces.
            const pages = await kbProvider.searchPages(args.externalTicketId, kbConfig.spaces);
            if (pages.length > 0) {
              rawDocumentation = pages;
            }
          }
        }
      } catch (kbErr) {
        fastify.log.warn(
          { err: kbErr, ticketId: args.externalTicketId },
          'Knowledge base enrichment failed; continuing without rawDocumentation'
        );
      }
    }

    const snapshotData: Record<string, unknown> = {
      rawTicketData: ticket as unknown as Prisma.InputJsonValue,
    };
    if (rawDocumentation !== null) {
      snapshotData.rawDocumentation = rawDocumentation as Prisma.InputJsonValue;
    }

    await fastify.prisma.contextSnapshot.upsert({
      create: {
        ...(snapshotData as {
          rawTicketData: Prisma.InputJsonValue;
          rawDocumentation?: Prisma.InputJsonValue;
        }),
        workRequestId: args.workRequestId,
      },
      update: snapshotData as {
        rawTicketData: Prisma.InputJsonValue;
        rawDocumentation?: Prisma.InputJsonValue;
      },
      where: { workRequestId: args.workRequestId },
    });

    // Return the ticket's searchable text so design enrichment can scan it for
    // Figma links without re-reading the snapshot (and even if the write above
    // silently failed).
    return JSON.stringify(ticket);
  } catch (err) {
    fastify.log.warn(
      { err, ticketId: args.externalTicketId, workRequestId: args.workRequestId },
      'Ticket tracker enrichment failed; continuing without rawTicketData'
    );
    return '';
  }
}

/**
 * Best-effort design enrichment: when the Figma connector is enabled and the
 * work request references a Figma file/node — in its own description or in the
 * ticket text handed over by `enrichWithTicketData` — fetch a compact design
 * summary and seed `ContextSnapshot.rawDesign`. Runs after `enrichWithTicketData`
 * (sequentially, so the two never race on the snapshot row); the upsert touches
 * only `rawDesign`, never clobbering ticket/documentation fields.
 *
 * Never throws and never blocks submission.
 */
const MAX_FIGMA_REFS = 3;

async function enrichWithDesignData(
  fastify: FastifyInstance,
  args: { description: string; ticketText: string; workRequestId: string }
): Promise<void> {
  try {
    const figma = await resolveFigmaConfig();
    if (!figma.enabled || !figma.apiToken) {
      return;
    }

    const refs = extractFigmaRefs(`${args.description}\n${args.ticketText}`).slice(
      0,
      MAX_FIGMA_REFS
    );
    if (refs.length === 0) {
      return;
    }

    const provider = createFigmaDesignProvider(figma);
    if (!provider) {
      return;
    }

    // fetchDesignSummary swallows its own errors and resolves to null, so a
    // plain Promise.all + null-filter is sufficient (no rejection to guard).
    const results = await Promise.all(
      refs.map((ref) => provider.fetchDesignSummary(ref, { log: fastify.log }))
    );
    const summaries = results.filter((s): s is NonNullable<typeof s> => s !== null);

    if (summaries.length === 0) {
      return;
    }

    await fastify.prisma.contextSnapshot.upsert({
      create: {
        rawDesign: summaries as unknown as Prisma.InputJsonValue,
        workRequestId: args.workRequestId,
      },
      update: { rawDesign: summaries as unknown as Prisma.InputJsonValue },
      where: { workRequestId: args.workRequestId },
    });
  } catch (err) {
    fastify.log.warn(
      { err, workRequestId: args.workRequestId },
      'Figma design enrichment failed; continuing without rawDesign'
    );
  }
}

/**
 * Resolve the active workflow template for a team, falling back to the
 * global default (teamId IS NULL). Returns {templateId, version} or null
 * if nothing is configured.
 *
 * Honors per-template A/B experiment configuration: if `experimentSplit` is
 * set and the bucketed externalTicketId lands below the split, returns
 * `experimentVersion` instead of `activeVersion`. Falls back silently to
 * `activeVersion` when either experiment field is missing.
 *
 * Uniqueness is enforced at the DB layer via partial unique indexes on
 * (team_id WHERE is_default), so `findFirst` returns at most one row in
 * a well-formed database. The explicit `orderBy` is a deterministic
 * tiebreaker if the index is dropped or someone bypasses Prisma.
 */
// Exported for unit tests; the route handler is the only production caller.
export async function resolveDefaultTemplate(
  prisma: FastifyInstance['prisma'],
  teamId: string,
  externalTicketId?: string
): Promise<{ templateId: string; version: number; isExperiment: boolean } | null> {
  const teamTpl = await prisma.workflowTemplate.findFirst({
    orderBy: [{ activeVersion: 'desc' }, { updatedAt: 'desc' }],
    where: { isDefault: true, status: 'ACTIVE', teamId },
  });
  const tpl =
    teamTpl ??
    (await prisma.workflowTemplate.findFirst({
      orderBy: [{ activeVersion: 'desc' }, { updatedAt: 'desc' }],
      where: { isDefault: true, status: 'ACTIVE', teamId: null },
    }));
  if (!tpl?.activeVersion) {
    return null;
  }

  const split = tpl.experimentSplit ?? 0;
  const expVersion = tpl.experimentVersion ?? null;
  if (split > 0 && expVersion !== null && externalTicketId) {
    const bucket = experimentBucket(externalTicketId, tpl.id);
    if (bucket < split) {
      return { isExperiment: true, templateId: tpl.id, version: expVersion };
    }
  }
  return { isExperiment: false, templateId: tpl.id, version: tpl.activeVersion };
}

const CreateWorkRequestSchema = z.object({
  budgetTier: z.enum(['STANDARD', 'LARGE', 'EPIC']).optional().default('STANDARD'),
  description: z
    .string()
    .min(1, 'description is required — tell the agent what to implement')
    .max(MAX_DESCRIPTION_LENGTH),
  externalTicketId: ExternalTicketIdSchema,
  repoIds: z.array(z.string().uuid()).min(1).max(1), // MVP: single repo only
});

const ListWorkRequestsQuery = paginationQuery({ defaultLimit: 50, maxLimit: 100 }).extend({
  /** Substring match on the external ticket ID. */
  ticket: z.string().max(200).optional(),
});

export const workRequestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // List/search work requests — answers "who asked the agent to do this?"
  app.get(
    '/',
    {
      config: { mcpScope: 'read' },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListWorkRequestsQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { limit, offset, ticket } = request.query;
      const where = {
        ...(ticket ? { externalTicketId: { contains: ticket, mode: 'insensitive' as const } } : {}),
        ...(user.role === 'ADMIN'
          ? {}
          : {
              activeWorkflows: {
                some: {
                  repository: reachableConnections(user, request.repoAccessGate),
                },
              },
            }),
      };
      const [rows, total] = await Promise.all([
        fastify.prisma.runInput.findMany({
          include: {
            activeWorkflows: {
              select: { currentStatus: true, id: true, temporalWorkflowId: true },
            },
            requestedBy: { select: { email: true, id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.runInput.count({ where }),
      ]);
      return {
        data: rows.map((wr) => ({
          activeWorkflows: wr.activeWorkflows,
          createdAt: wr.createdAt,
          description: wr.description,
          externalTicketId: wr.externalTicketId,
          id: wr.id,
          requestedBy: wr.requestedBy,
          templateId: wr.templateId,
          templateVersion: wr.templateVersion,
        })),
        meta: { limit, offset, total },
      };
    }
  );

  app.post(
    '/',
    {
      // An MCP write tool reaches this route through the bridge; `assertMcpWriteAllowed` below
      // is what bounds it, and the hook writes its audit row.
      config: { mcpScope: 'write' },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      onSend: mcpWriteAuditHook,
      preValidation: mcpWriteBegin('submit_work_request'),
      schema: {
        body: CreateWorkRequestSchema,
        headers: IdempotencyHeaderSchema,
      },
    },
    async (request, reply) => {
      const { externalTicketId, description, repoIds, budgetTier } = request.body;
      const user = requireUser(request);
      const idempotencyKey = request.headers['idempotency-key'];

      // A bridged MCP call is bounded here, ahead of everything else and in particular ahead of
      // the idempotency replay below, so the write switch, the burst limit, the tier and the key
      // rule apply to a replay as to a first submission. REST callers pass straight through.
      const mcpWrite = await assertMcpWriteAllowed(request, reply, {
        submit: { budgetTier, idempotencyKey },
        tool: 'submit_work_request',
      });
      if (mcpWrite.refused) {
        return mcpWrite.refused;
      }

      // Verify repository exists and is accessible to the requesting user.
      // Include team membership + org info so non-admins can only trigger work
      // on their own team's repos and the org budget cap can be checked.
      const loadRepo = (id: string) =>
        fastify.prisma.connection.findUnique({
          include: {
            installation: { select: { host: true, installationId: true, isActive: true } },
            // A member of a team the repository is shared with may launch too.
            shares: repoMembersSelect({ userId: true }, { userId: user.sub }).shares,
            team: {
              select: {
                memberships: {
                  select: { userId: true },
                  where: { userId: user.sub },
                },
                organization: {
                  select: { id: true, monthlyBudgetUsdCents: true },
                },
                orgId: true,
              },
            },
          },
          where: { id },
        });

      // `Idempotency-Key`: a retry of a submission this user already made answers
      // with the run it started rather than a second one. Checked before anything
      // else so a replay never allocates an id, and looked up again wherever a
      // concurrent same-key request could have won the race. The key is scoped to
      // the authenticated user; nothing here reads a client-supplied owner.
      //
      // A row only replays as success once `startedActiveWorkflowId` is stamped,
      // i.e. after the Temporal start succeeded. Until then the ledger rows exist
      // but the run may yet be compensated away, so the answer is "in progress".
      //
      // It returns the reply wrapped in an object, never the reply itself: a Fastify reply is a
      // thenable, so `await`ing an async function that returns one resolves to `undefined` once
      // it has been sent, and the handler would carry on past the answer it just gave.
      const sent = (sentReply: FastifyReply) => ({ reply: sentReply });
      const replayForKey = async () => {
        if (!idempotencyKey) {
          return null;
        }
        const prior = await fastify.prisma.runInput.findUnique({
          select: {
            connectionId: true,
            description: true,
            externalTicketId: true,
            id: true,
            payload: true,
            startedActiveWorkflowId: true,
          },
          where: { requestedById_idempotencyKey: { idempotencyKey, requestedById: user.sub } },
        });
        if (!prior) {
          return null;
        }
        const priorBudget = (prior.payload as { budget?: unknown } | null)?.budget;
        if (
          prior.externalTicketId !== externalTicketId ||
          prior.description !== description ||
          prior.connectionId !== repoIds[0] ||
          priorBudget !== budgetTier
        ) {
          return sent(
            reply.status(422).send({
              error: {
                code: 'IDEMPOTENCY_KEY_MISMATCH',
                message:
                  'This Idempotency-Key was already used for a different request. Use a new key for a different ticket, repository, description or budget tier.',
              },
            })
          );
        }
        if (!prior.startedActiveWorkflowId) {
          return sent(
            reply
              .status(409)
              .header('retry-after', '2')
              .send({
                error: {
                  code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
                  message:
                    'A request with this Idempotency-Key has not finished starting. Retry shortly with the same key.',
                },
              })
          );
        }
        // The run exists, but only someone who could launch it now may be told its
        // ids: re-check repository access and org membership. The org's monthly
        // cap is deliberately not re-applied -- a replay starts and spends nothing.
        const priorRepo = await loadRepo(prior.connectionId as string);
        if (!priorRepo?.isActive) {
          return sent(
            reply.status(404).send({
              error: { code: 'REPO_NOT_FOUND', message: 'Repository not found or inactive' },
            })
          );
        }
        const authorization = await authorizeLaunch(fastify.prisma, user, {
          gate: request.repoAccessGate,
          log: request.log,
          repos: [priorRepo],
          runIdentity: 'caller',
        });
        if (!authorization.ok && authorization.refusal.kind !== 'org-budget') {
          return sent(sendLaunchRefusal(reply, authorization.refusal));
        }
        return sent(
          reply.status(200).send({
            data: {
              deduplicated: true,
              workflowIds: [prior.startedActiveWorkflowId],
              workRequestId: prior.id,
            },
          })
        );
      };
      const replayed = await replayForKey();
      if (replayed) {
        return replayed.reply;
      }

      const repo = await loadRepo(repoIds[0]);
      if (!repo?.isActive) {
        return reply.status(404).send({
          error: {
            code: 'REPO_NOT_FOUND',
            message: `Repository ${repoIds[0]} not found or inactive`,
          },
        });
      }

      // Repository access, org membership and the org's monthly cap — the one
      // decision every launch path takes.
      const authorization = await authorizeLaunch(fastify.prisma, user, {
        gate: request.repoAccessGate,
        log: request.log,
        repos: [repo],
        // The run is launched as the caller (`launchedById`), so it may use their own
        // saved token, and the gate judges that token.
        runIdentity: 'caller',
      });
      if (!authorization.ok) {
        return sendLaunchRefusal(reply, authorization.refusal);
      }

      // A SWE work request targets a git_repo connection (org/repo are nullable
      // on Connection since non-git types like `mcp` omit them).
      if (!isGitRepoConnection(repo)) {
        return reply.status(400).send({
          error: {
            code: 'NOT_A_GIT_REPO',
            message: `Connection ${repo.id} is not a git_repo connection`,
          },
        });
      }

      // Generate deterministic workflow ID (includes org to prevent cross-org collisions).
      // Re-submitting a finished ticket allocates an -rN suffix instead of
      // 500ing on the unique temporalWorkflowId and leaving a zombie
      // Temporal execution with no tracking row.
      const baseWorkflowId = generateWorkflowId(
        externalTicketId,
        repo.organizationName,
        repo.repoName,
        repo.githubUrl
      );
      // The ids this ticket had before the current format (stored casing, no
      // host): an execution still running under one blocks a duplicate exactly
      // as one under the new id does.
      const allocate = () =>
        allocateWorkflowId(
          fastify.prisma,
          baseWorkflowId,
          { externalTicketId, repoId: repo.id },
          legacyWorkflowIdBases(
            externalTicketId,
            repo.organizationName,
            repo.repoName,
            repo.githubUrl
          )
        );
      const allocated = await allocate();

      // The ticket is held by a run that is not this key's. With a key, the holder
      // may have been a same-key request that has since compensated (its Temporal
      // start failed), in which case nothing runs and the honest answer is "retry",
      // not "already running".
      const refuseConflict = async (message: string, source: 'ledger' | 'temporal' = 'ledger') => {
        if (
          idempotencyKey &&
          source === 'ledger' &&
          !('conflictWorkflowId' in (await allocate()))
        ) {
          return reply
            .status(409)
            .header('retry-after', '1')
            .send({
              error: {
                code: 'IDEMPOTENCY_KEY_RETRY',
                message:
                  'A concurrent request with this Idempotency-Key did not start a run. Retry with the same key.',
              },
            });
        }
        return reply.status(409).send({ error: { code: 'WORKFLOW_ALREADY_EXISTS', message } });
      };
      if ('conflictWorkflowId' in allocated) {
        // A same-key request that committed after the lookup above is what this
        // conflict may be; a different key (or none) is a real second submission.
        const raced = await replayForKey();
        if (raced) {
          return raced.reply;
        }
        return refuseConflict(
          // Another row's run (possibly another team's) is not named.
          allocated.conflictOtherRow
            ? `Workflow already running for ${externalTicketId} for this repository`
            : `Workflow already running for ${externalTicketId} (${allocated.conflictWorkflowId})`
        );
      }
      const temporalWorkflowId = allocated.workflowId;
      const { branchPrefix } = await resolveWorkflowDefaults();
      const branch = generateBranchName(externalTicketId, branchPrefix);

      // Generate the work request ID upfront so it can be passed to Temporal
      // before the DB row exists. This avoids the ordering problem where
      // the workflow needs the ID but the DB write happens after workflow start.
      const workRequestId = crypto.randomUUID();

      // Canary routing: deterministically route a fraction of runs to a candidate
      // agent version.
      const canaryPin = await resolveCanaryPin(workRequestId);

      // Resolve which workflow template to run. Team-scoped default wins; falls
      // back to the global teamId=null template seeded by `yarn db:seed`.
      // A/B experiments are honored via deterministic bucketing on externalTicketId.
      const resolvedTemplate = await resolveDefaultTemplate(
        fastify.prisma,
        repo.teamId,
        externalTicketId
      );
      if (!resolvedTemplate) {
        return reply.status(500).send({
          error: {
            code: 'NO_DEFAULT_TEMPLATE',
            message: 'No default workflow template configured. Run `yarn db:seed`.',
          },
        });
      }

      // P3: build the generic run-input payload and validate it against the
      // template's declared inputSchema (if any). SWE maps its request fields
      // onto the seeded `{ ticketId, connectionId, description, budget }`
      // contract; templates without a schema accept any payload. Validate
      // before starting Temporal so a bad payload never leaves an orphan run.
      const payload = {
        budget: budgetTier,
        connectionId: repo.id,
        description,
        ticketId: externalTicketId,
      };
      const tpl = await fastify.prisma.workflowTemplate.findUnique({
        select: { inputSchema: true },
        where: { id: resolvedTemplate.templateId },
      });
      if (tpl?.inputSchema && isInputSchema(tpl.inputSchema)) {
        const result = validateInputPayload(tpl.inputSchema, payload);
        if (!result.ok) {
          return reply.status(400).send({
            error: {
              code: 'INVALID_INPUT',
              details: result.errors,
              message: `Run input does not satisfy the template's input schema: ${result.errors.join('; ')}`,
            },
          });
        }
      }

      // Ledger rows are written BEFORE the workflow starts, and rolled back if
      // it fails to start — see `launchTrackedWorkflow` for why that ordering
      // is the safe one. The unique index on `temporalWorkflowId` is the
      // atomic dedup gate.
      const repoWorkRequest: RepoWorkRequest = {
        budgetTier,
        description,
        externalTicketId,
        launchedById: user.sub,
        repoId: repo.id,
        requestPayload: JSON.stringify(request.body),
        workRequestId,
        ...(canaryPin ?? {}),
      };
      const launch = await launchTrackedWorkflow(
        fastify.prisma,
        {
          activeWorkflow: {
            assignedBranch: branch,
            budgetTier,
            currentStatus: 'IMPLEMENTING',
            repoId: repo.id,
            temporalWorkflowId,
            workRequestId,
          },
          runInput: {
            connectionId: repo.id,
            description,
            externalTicketId,
            id: workRequestId,
            ...(idempotencyKey ? { idempotencyKey } : {}),
            payload,
            requestedById: user.sub,
            requestPayload: JSON.stringify(request.body),
            templateId: resolvedTemplate.templateId,
            templateVersion: resolvedTemplate.version,
          },
        },
        () =>
          fastify.temporal.startRunnableWorkflow(temporalWorkflowId, {
            request: repoWorkRequest,
            templateId: resolvedTemplate.templateId,
            templateVersion: resolvedTemplate.version,
          }),
        { guard: mcpWrite.launchGuard, log: fastify.log }
      );
      if (!launch.ok && launch.reason === 'GUARD_REFUSED') {
        // A retry of this key whose first submit committed while this one waited for the lock is
        // a replay, not a request the cap should turn away.
        const raced = await replayForKey();
        if (raced) {
          return raced.reply;
        }
        return sendRunCapRefusal(reply);
      }
      if (!launch.ok) {
        // Losing the unique-index race to a same-key request is a replay, not a
        // conflict. If the winner's start failed it compensated and freed the key,
        // so nothing is found and this is the ordinary 409.
        const raced = await replayForKey();
        if (raced) {
          return raced.reply;
        }
        // A Temporal-side duplicate is a live execution no row accounts for: it is running,
        // so keyed and unkeyed requests alike get the ordinary conflict, not "retry".
        return refuseConflict(`Workflow already running for ${externalTicketId}`, launch.source);
      }
      // Confirm the start so a replay of this key answers with the run. If this write
      // fails the run is already going; the key then stays "in progress" (409) rather
      // than ever reporting a run that did not start, and the submission still succeeds.
      if (idempotencyKey && launch.activeWorkflowId) {
        const startedActiveWorkflowId = launch.activeWorkflowId;
        for (let attempt = 1; ; attempt++) {
          try {
            await fastify.prisma.runInput.update({
              data: { startedActiveWorkflowId },
              where: { id: workRequestId },
            });
            break;
          } catch (err) {
            if (attempt === 3) {
              fastify.log.error(
                { err, startedActiveWorkflowId, workRequestId },
                'could not confirm idempotent launch; key will report in-progress'
              );
              break;
            }
          }
        }
      }
      // Best-effort enrichment runs after the response: the ticket and
      // knowledge-base fetches are network calls to third parties, and nothing
      // they write gates the submission. Design enrichment reuses the fetched
      // ticket text, so the two stay sequential. (The retry endpoint skips this
      // — it reuses the original snapshot.)
      const { organizationName, repoName } = repo;
      void (async () => {
        const ticketText = await enrichWithTicketData(fastify, {
          externalTicketId,
          repo: { organizationName, repoName },
          workRequestId,
        });
        await enrichWithDesignData(fastify, { description, ticketText, workRequestId });
      })().catch((err: unknown) => {
        fastify.log.warn({ err, workRequestId }, 'work-request enrichment failed');
      });

      return reply.status(201).send({
        data: {
          workflowIds: [launch.activeWorkflowId],
          workRequestId,
        },
      });
    }
  );

  // Re-run a finished work request: starts a fresh Temporal execution (with
  // an -rN workflow-ID suffix) against the same ticket/repo/branch, reusing
  // the recorded template snapshot so the retry is reproducible.
  app.post<{ Params: { id: string }; Body: { instructions?: string } | null }>(
    '/:id/retry',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        body: z.object({ instructions: z.string().trim().max(4000).optional() }).nullish(),
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const workRequest = await fastify.prisma.runInput.findUnique({
        include: {
          activeWorkflows: {
            include: {
              repository: {
                include: {
                  installation: { select: { host: true, installationId: true, isActive: true } },
                  shares: repoMembersSelect({ userId: true }, { userId: user.sub }).shares,
                  team: {
                    select: {
                      memberships: { select: { userId: true }, where: { userId: user.sub } },
                      organization: { select: { monthlyBudgetUsdCents: true } },
                      orgId: true,
                    },
                  },
                },
              },
            },
            orderBy: { updatedAt: 'desc' },
          },
        },
        where: { id: request.params.id },
      });
      if (workRequest?.isCrossRepo) {
        return reply.status(409).send({
          error: {
            code: 'EPIC_RETRY_REQUIRED',
            message: 'Multi-repository work must be launched through the epic workflow',
          },
        });
      }
      const latest = workRequest?.activeWorkflows.find((w) => w.repository);
      const repo = latest?.repository;
      if (workRequest && repo?.type !== 'git_repo') {
        return retryTemplateRequest(
          fastify,
          request,
          reply,
          workRequest,
          request.body?.instructions
        );
      }
      if (!workRequest || !latest || !repo) {
        return reply.status(404).send({
          error: { code: 'WORK_REQUEST_NOT_FOUND', message: 'Work request not found' },
        });
      }
      if (!repo.isActive) {
        return reply.status(409).send({
          error: { code: 'REPO_INACTIVE', message: 'Repository is no longer active' },
        });
      }
      // A re-run pushes, opens a pull request and spends exactly like a fresh
      // submission, so it takes the same decision. Skipping it would leave a
      // standing way to act on a repository after access was revoked, for as
      // long as an old work request exists.
      const authorization = await authorizeLaunch(fastify.prisma, user, {
        gate: request.repoAccessGate,
        log: request.log,
        repos: [repo],
        // The re-run is launched as its caller, like a fresh submission.
        runIdentity: 'caller',
      });
      if (!authorization.ok) {
        return sendLaunchRefusal(reply, authorization.refusal);
      }
      if (!workRequest.templateId || !workRequest.templateVersion) {
        return reply.status(409).send({
          error: { code: 'NO_TEMPLATE_SNAPSHOT', message: 'Work request has no recorded template' },
        });
      }
      // An agent run keeps its launch parameters in the payload this endpoint
      // does not carry, and a re-run reusing its ticket id would collide with the
      // branch the first run already pushed. It has its own re-run.
      const snapshotTemplate = await fastify.prisma.workflowTemplate.findFirst({
        select: { origin: true, teamId: true },
        where: { id: workRequest.templateId },
      });
      if (snapshotTemplate && isSystemTemplate(snapshotTemplate)) {
        return reply.status(409).send({
          error: {
            code: 'USE_AGENT_RUN_RERUN',
            message: 'This is an agent run; re-run it with POST /api/v1/agent-runs/:id/rerun',
          },
        });
      }
      // The same launch checks as a fresh template launch: the template must be
      // ACTIVE and visible to the caller, and a recorded payload must still
      // satisfy its input schema. The recorded version is what runs.
      const launchable = await fastify.prisma.workflowTemplate.findFirst({
        select: { inputSchema: true },
        where: launchableTemplateWhere(user, workRequest.templateId),
      });
      if (!launchable) {
        return sendTemplateNotLaunchable(reply);
      }
      if (
        workRequest.payload &&
        typeof workRequest.payload === 'object' &&
        !Array.isArray(workRequest.payload) &&
        !inputsSatisfySchema(reply, launchable.inputSchema, {
          ...workRequest.payload,
          ...(request.body?.instructions &&
          typeof (workRequest.payload as Record<string, unknown>).description === 'string'
            ? {
                description: `${workRequest.description}\n\nAdditional instructions for this attempt:\n${request.body.instructions}`,
              }
            : {}),
        })
      ) {
        return;
      }
      // Bind the narrowed values: the start call below runs inside a closure,
      // where TS can't carry a property narrowing.
      const retryTemplateId = workRequest.templateId;
      const retryTemplateVersion = workRequest.templateVersion;

      if (!isGitRepoConnection(repo)) {
        return reply.status(400).send({
          error: { code: 'NOT_A_GIT_REPO', message: 'Work request target is not a git_repo' },
        });
      }
      const baseWorkflowId = generateWorkflowId(
        workRequest.externalTicketId,
        repo.organizationName,
        repo.repoName,
        repo.githubUrl
      );
      const settled = fastify.temporal.workflowSettledStatus;
      // `otherRow`: the row belongs to another connection row, whose workflow id
      // the other 409s do not name either.
      const unconfirmedReply = (workflowId: string, otherRow = false) =>
        reply.status(409).send({
          error: {
            code: 'WORKFLOW_ALREADY_EXISTS',
            message: `Could not confirm whether ${otherRow ? 'a run' : workflowId} for ${workRequest.externalTicketId} has finished (Temporal unreachable); retry shortly`,
          },
        });

      // A scheduled request's fires run under `sched-<id>-<ts>`, which the
      // allocator below never reads, and a re-run pushing the same branch while
      // one is in flight would adopt and re-link its pull request, leaving the
      // earlier run waiting on CI that never reports. This runs first so that a
      // row of this request whose execution is over (the commonest: a previous
      // `eng-…` run terminated before its first activity, which has no run row
      // for the reaper) is closed before the allocator would refuse on it.
      const running = await liveInFlightExecution(fastify.prisma, workRequest.id, { settled });
      if (running) {
        return running.unconfirmed
          ? unconfirmedReply(running.temporalWorkflowId)
          : reply.status(409).send({
              error: {
                code: 'WORKFLOW_ALREADY_EXISTS',
                message: `Workflow still running for ${workRequest.externalTicketId} (${running.temporalWorkflowId})`,
              },
            });
      }

      const allocate = () =>
        allocateWorkflowId(
          fastify.prisma,
          baseWorkflowId,
          { externalTicketId: workRequest.externalTicketId, repoId: repo.id },
          legacyWorkflowIdBases(
            workRequest.externalTicketId,
            repo.organizationName,
            repo.repoName,
            repo.githubUrl
          )
        );
      let allocated = await allocate();
      // The allocator refuses on any non-terminal row of the ticket's family,
      // including another request's, without asking Temporal. Confirm the row it
      // names the same way and allocate again once a finished one is closed.
      for (let attempt = 0; attempt < 3 && 'conflictWorkflowId' in allocated; attempt++) {
        const stillRunning = await confirmInFlight(fastify.prisma, allocated.conflictWorkflowId, {
          settled,
        });
        if (stillRunning) {
          if (stillRunning.unconfirmed) {
            return unconfirmedReply(stillRunning.temporalWorkflowId, allocated.conflictOtherRow);
          }
          break;
        }
        allocated = await allocate();
      }
      if ('conflictWorkflowId' in allocated) {
        return reply.status(409).send({
          error: {
            code: 'WORKFLOW_ALREADY_EXISTS',
            message: allocated.conflictOtherRow
              ? `Workflow still running for ${workRequest.externalTicketId} for this repository`
              : `Workflow still running for ${workRequest.externalTicketId} (${allocated.conflictWorkflowId})`,
          },
        });
      }

      // Canary routing for re-runs: same determinism — same workRequestId
      // → same canary arm.
      const canaryPin = await resolveCanaryPin(workRequest.id);

      const repoWorkRequest: RepoWorkRequest = {
        budgetTier: latest.budgetTier as RepoWorkRequest['budgetTier'],
        connectionId: repo.id,
        description: request.body?.instructions
          ? `${workRequest.description}\n\nAdditional instructions for this attempt:\n${request.body.instructions}`
          : workRequest.description,
        externalTicketId: workRequest.externalTicketId,
        // Whoever re-runs it, not whoever first asked: the re-run acts as the
        // caller, including with their own saved GitHub token, never as the
        // original requester's.
        launchedById: user.sub,
        payload:
          workRequest.payload &&
          typeof workRequest.payload === 'object' &&
          !Array.isArray(workRequest.payload)
            ? {
                ...workRequest.payload,
                ...(request.body?.instructions &&
                typeof (workRequest.payload as Record<string, unknown>).description === 'string'
                  ? {
                      description: `${workRequest.description}\n\nAdditional instructions for this attempt:\n${request.body.instructions}`,
                    }
                  : {}),
              }
            : undefined,
        repoId: repo.id,
        requestPayload: workRequest.requestPayload,
        workRequestId: workRequest.id,
        workspaceProvider: 'git_repo',
        ...(canaryPin ?? {}),
      };
      // Re-run: the RunInput already exists, so only the ActiveWorkflow row is
      // written — again before the start, and rolled back if it fails.
      const launch = await launchTrackedWorkflow(
        fastify.prisma,
        {
          activeWorkflow: {
            assignedBranch: latest.assignedBranch,
            budgetTier: latest.budgetTier,
            currentStatus: 'IMPLEMENTING',
            repoId: repo.id,
            temporalWorkflowId: allocated.workflowId,
            workRequestId: workRequest.id,
          },
        },
        () =>
          fastify.temporal.startRunnableWorkflow(allocated.workflowId, {
            request: repoWorkRequest,
            templateId: retryTemplateId,
            templateVersion: retryTemplateVersion,
          }),
        { log: fastify.log }
      );
      if (!launch.ok) {
        return reply.status(409).send({
          error: {
            code: 'WORKFLOW_ALREADY_EXISTS',
            message: `Workflow already running for ${workRequest.externalTicketId}`,
          },
        });
      }
      return reply.status(201).send({
        data: {
          // The Temporal workflow id keys the WorkflowRun row the worker
          // creates once the workflow begins, so a client can find the new run
          // by it. `workflowIds` holds ledger ids, which no run is keyed by.
          temporalWorkflowId: allocated.workflowId,
          workflowIds: [launch.activeWorkflowId],
          workRequestId: workRequest.id,
        },
      });
    }
  );
};
