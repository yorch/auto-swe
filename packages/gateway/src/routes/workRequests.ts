import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { isGitRepoConnection } from '@auto-swe/shared/lib/connectionGuards';
import { isInputSchema, validateInputPayload } from '@auto-swe/shared/lib/inputSchema';
import { createKnowledgeBaseProvider } from '@auto-swe/shared/lib/integrations/registry';
import {
  resolveIssueTrackerConfig,
  resolveKnowledgeBaseConfig,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import { generateBranchName, generateWorkflowId } from '@auto-swe/shared/lib/workflowId';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { fetchTicket } from '../lib/issueTrackerClient.js';
import { assertOrgAccess, currentYearMonth } from '../lib/orgAccess.js';
import { getErrorName, requireAuth, requireUser } from '../plugins/auth.js';

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
 * Never throws and never blocks submission — every failure is logged and
 * swallowed.
 */
async function enrichWithTicketData(
  fastify: FastifyInstance,
  args: {
    externalTicketId: string;
    repo: { organizationName: string; repoName: string };
    workRequestId: string;
  }
): Promise<void> {
  try {
    const tracker = await resolveIssueTrackerConfig();

    if (!tracker.provider) {
      return;
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
      return;
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
  } catch (err) {
    fastify.log.warn(
      { err, ticketId: args.externalTicketId, workRequestId: args.workRequestId },
      'Ticket tracker enrichment failed; continuing without rawTicketData'
    );
  }
}

/**
 * Deterministic 0–99 bucket for an A/B key. Uses sha1 mod 100 so the same
 * `externalTicketId` always lands in the same bucket — re-runs of the same
 * ticket cannot accidentally cross the experiment boundary.
 *
 * Salting by `templateId` keeps two templates' experiments statistically
 * independent: a ticket bucketed into the experiment arm on template A is
 * uncorrelated with its bucket on template B.
 */
export function experimentBucket(externalTicketId: string, templateId: string): number {
  const hash = crypto.createHash('sha1').update(`${templateId}:${externalTicketId}`).digest();
  // First 4 bytes is plenty of entropy for a mod-100 bucket.
  return hash.readUInt32BE(0) % 100;
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

/** ActiveWorkflow statuses that mean "this execution is over". */
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);

/**
 * Allocate the Temporal workflow ID for a ticket+repo. First submission uses
 * the deterministic base ID; re-running a finished ticket gets an `-rN`
 * suffix so Temporal, WorkflowRun (unique on workflowId), and ActiveWorkflow
 * (unique on temporalWorkflowId) all see a fresh execution instead of
 * colliding with the previous one. Returns a conflict when an execution for
 * this ticket+repo is still in flight.
 */
async function allocateWorkflowId(
  prisma: FastifyInstance['prisma'],
  baseId: string
): Promise<{ workflowId: string; isRerun: boolean } | { conflictWorkflowId: string }> {
  const rows = await prisma.activeWorkflow.findMany({
    select: { currentStatus: true, temporalWorkflowId: true },
    where: {
      OR: [{ temporalWorkflowId: baseId }, { temporalWorkflowId: { startsWith: `${baseId}-r` } }],
    },
  });
  // The startsWith match can catch a *different* ticket whose ID happens to
  // extend this one — keep only the base ID and exact `-r<N>` suffixes.
  const suffixRe = new RegExp(`^${baseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-r\\d+)?$`);
  const existing = rows.filter((w) => suffixRe.test(w.temporalWorkflowId));
  if (existing.length === 0) {
    return { isRerun: false, workflowId: baseId };
  }
  const active = existing.find((w) => !TERMINAL_STATUSES.has(w.currentStatus));
  if (active) {
    return { conflictWorkflowId: active.temporalWorkflowId };
  }
  return { isRerun: true, workflowId: `${baseId}-r${existing.length + 1}` };
}

const CreateWorkRequestSchema = z.object({
  budgetTier: z.enum(['STANDARD', 'LARGE', 'EPIC']).optional().default('STANDARD'),
  description: z.string().min(1, 'description is required — tell the agent what to implement'),
  externalTicketId: z.string().min(1),
  repoIds: z.array(z.string().uuid()).min(1).max(1), // MVP: single repo only
});

const ListWorkRequestsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /** Substring match on the external ticket ID. */
  ticket: z.string().max(200).optional(),
});

export const workRequestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // List/search work requests — answers "who asked the agent to do this?"
  app.get(
    '/',
    {
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
                  repository: { team: { memberships: { some: { userId: user.sub } } } },
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
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        body: CreateWorkRequestSchema,
      },
    },
    async (request, reply) => {
      const { externalTicketId, description, repoIds, budgetTier } = request.body;
      const user = requireUser(request);

      // Verify repository exists and is accessible to the requesting user.
      // Include team membership + org info so non-admins can only trigger work
      // on their own team's repos and the org budget cap can be checked.
      const repo = await fastify.prisma.connection.findUnique({
        include: {
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
        where: { id: repoIds[0] },
      });
      if (!repo?.isActive) {
        return reply.status(404).send({
          error: {
            code: 'REPO_NOT_FOUND',
            message: `Repository ${repoIds[0]} not found or inactive`,
          },
        });
      }

      if (user.role !== 'ADMIN' && repo.team.memberships.length === 0) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this repository' },
        });
      }

      // Org access check (P5): non-admins must be members of the repo's org.
      const orgId = repo.team.orgId;
      if (user.role !== 'ADMIN') {
        const hasAccess = await assertOrgAccess(fastify.prisma, user, orgId, reply);
        if (!hasAccess) {
          return;
        }
      }

      // Org budget cap check (P5): reject if the org has exceeded its monthly cap.
      const budgetCap = repo.team.organization?.monthlyBudgetUsdCents;
      if (budgetCap != null) {
        const usage = await fastify.prisma.orgMonthlyUsage.findUnique({
          where: { orgId_yearMonth: { orgId, yearMonth: currentYearMonth() } },
        });
        const spentCents = Math.round(Number(usage?.costUsdAccrued ?? 0) * 100);
        if (spentCents >= budgetCap) {
          return reply.status(402).send({
            error: {
              code: 'ORG_BUDGET_EXCEEDED',
              message: `Organization has exceeded its monthly budget cap of ${budgetCap} USD cents`,
            },
          });
        }
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
        repo.repoName
      );
      const allocated = await allocateWorkflowId(fastify.prisma, baseWorkflowId);
      if ('conflictWorkflowId' in allocated) {
        return reply.status(409).send({
          error: {
            code: 'WORKFLOW_ALREADY_EXISTS',
            message: `Workflow already running for ${externalTicketId} (${allocated.conflictWorkflowId})`,
          },
        });
      }
      const temporalWorkflowId = allocated.workflowId;
      const { branchPrefix } = await resolveWorkflowDefaults();
      const branch = generateBranchName(externalTicketId, branchPrefix);

      // Generate the work request ID upfront so it can be passed to Temporal
      // before the DB row exists. This avoids the ordering problem where
      // the workflow needs the ID but the DB write happens after workflow start.
      const workRequestId = crypto.randomUUID();

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

      // Start Temporal workflow FIRST — this is the idempotency gate.
      // If the workflow already exists, Temporal returns WorkflowExecutionAlreadyStartedError
      // and we haven't written any orphan DB rows yet.
      const repoWorkRequest: RepoWorkRequest = {
        budgetTier,
        description,
        externalTicketId,
        repoId: repo.id,
        requestPayload: JSON.stringify(request.body),
        workRequestId,
      };
      try {
        await fastify.temporal.startRunnableWorkflow(temporalWorkflowId, {
          request: repoWorkRequest,
          templateId: resolvedTemplate.templateId,
          templateVersion: resolvedTemplate.version,
        });
      } catch (err: unknown) {
        if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
          return reply.status(409).send({
            error: {
              code: 'WORKFLOW_ALREADY_EXISTS',
              message: `Workflow already running for ${externalTicketId}`,
            },
          });
        }
        throw err;
      }

      // Workflow started — now persist to DB.
      // If DB write fails, the Temporal workflow will eventually time out,
      // which is preferable to orphan DB rows that block future retries.
      const workRequest = await fastify.prisma.runInput.create({
        data: {
          connectionId: repo.id,
          description,
          externalTicketId,
          id: workRequestId,
          payload,
          requestedById: user.sub,
          requestPayload: JSON.stringify(request.body),
          templateId: resolvedTemplate.templateId,
          templateVersion: resolvedTemplate.version,
        },
      });

      const activeWorkflow = await fastify.prisma.activeWorkflow.create({
        data: {
          assignedBranch: branch,
          budgetTier,
          currentStatus: 'IMPLEMENTING',
          repoId: repo.id,
          temporalWorkflowId,
          workRequestId: workRequest.id,
        },
      });

      // Best-effort: seed the context snapshot with the external ticket's
      // content when a tracker connector is configured. Failures are logged
      // and never affect the 201. (The retry endpoint intentionally skips
      // this — it reuses the original snapshot.)
      await enrichWithTicketData(fastify, {
        externalTicketId,
        repo: { organizationName: repo.organizationName, repoName: repo.repoName },
        workRequestId: workRequest.id,
      });

      return reply.status(201).send({
        data: {
          workflowIds: [activeWorkflow.id],
          workRequestId: workRequest.id,
        },
      });
    }
  );

  // Re-run a finished work request: starts a fresh Temporal execution (with
  // an -rN workflow-ID suffix) against the same ticket/repo/branch, reusing
  // the recorded template snapshot so the retry is reproducible.
  app.post<{ Params: { id: string } }>(
    '/:id/retry',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const workRequest = await fastify.prisma.runInput.findUnique({
        include: {
          activeWorkflows: {
            include: {
              repository: {
                include: {
                  team: {
                    select: {
                      memberships: { select: { userId: true }, where: { userId: user.sub } },
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
      const latest = workRequest?.activeWorkflows.find((w) => w.repository);
      const repo = latest?.repository;
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
      if (user.role !== 'ADMIN' && repo.team.memberships.length === 0) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this repository' },
        });
      }
      if (!workRequest.templateId || !workRequest.templateVersion) {
        return reply.status(409).send({
          error: { code: 'NO_TEMPLATE_SNAPSHOT', message: 'Work request has no recorded template' },
        });
      }

      if (!isGitRepoConnection(repo)) {
        return reply.status(400).send({
          error: { code: 'NOT_A_GIT_REPO', message: 'Work request target is not a git_repo' },
        });
      }
      const baseWorkflowId = generateWorkflowId(
        workRequest.externalTicketId,
        repo.organizationName,
        repo.repoName
      );
      const allocated = await allocateWorkflowId(fastify.prisma, baseWorkflowId);
      if ('conflictWorkflowId' in allocated) {
        return reply.status(409).send({
          error: {
            code: 'WORKFLOW_ALREADY_EXISTS',
            message: `Workflow still running for ${workRequest.externalTicketId} (${allocated.conflictWorkflowId})`,
          },
        });
      }

      const repoWorkRequest: RepoWorkRequest = {
        budgetTier: latest.budgetTier as RepoWorkRequest['budgetTier'],
        description: workRequest.description,
        externalTicketId: workRequest.externalTicketId,
        repoId: repo.id,
        requestPayload: workRequest.requestPayload,
        workRequestId: workRequest.id,
      };
      try {
        await fastify.temporal.startRunnableWorkflow(allocated.workflowId, {
          request: repoWorkRequest,
          templateId: workRequest.templateId,
          templateVersion: workRequest.templateVersion,
        });
      } catch (err: unknown) {
        if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
          return reply.status(409).send({
            error: {
              code: 'WORKFLOW_ALREADY_EXISTS',
              message: `Workflow already running for ${workRequest.externalTicketId}`,
            },
          });
        }
        throw err;
      }

      const activeWorkflow = await fastify.prisma.activeWorkflow.create({
        data: {
          assignedBranch: latest.assignedBranch,
          budgetTier: latest.budgetTier,
          currentStatus: 'IMPLEMENTING',
          repoId: repo.id,
          temporalWorkflowId: allocated.workflowId,
          workRequestId: workRequest.id,
        },
      });

      return reply.status(201).send({
        data: {
          workflowIds: [activeWorkflow.id],
          workRequestId: workRequest.id,
        },
      });
    }
  );
};
