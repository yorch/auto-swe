import crypto from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getErrorName, requireAuth, requireUser } from '../plugins/auth.js';

const CreateEpicSchema = z.object({
  description: z
    .string()
    .min(1, 'description is required — tell the agent what to build across repos'),
  externalTicketId: z.string().min(1),
  repoIds: z.array(z.string().uuid()).min(1),
});

const ListEpicsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const EpicParams = z.object({
  workflowId: z.string().min(1),
});

const EPIC_ID_PREFIX = 'epic-';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Epics are persisted as WorkRequest rows with `isCrossRepo: true` whose
 * `requestPayload` is the original POST body (including `repoIds`). The epic's
 * own ActiveWorkflow row is self-registered by the orchestrator's first
 * `updateDomainState` call with `repoId: null`, so the repo set is only
 * recoverable from this payload.
 */
export function parseRepoIdsFromPayload(payload: string): string[] {
  try {
    const parsed = JSON.parse(payload) as { repoIds?: unknown };
    if (Array.isArray(parsed.repoIds)) {
      return parsed.repoIds.filter((id): id is string => typeof id === 'string');
    }
  } catch {
    // Malformed legacy payload — treat as "no repos known".
  }
  return [];
}

/** Repo IDs the user can see through team membership (non-admin visibility). */
async function accessibleRepoIds(
  prisma: FastifyInstance['prisma'],
  userId: string
): Promise<Set<string>> {
  const rows = await prisma.connection.findMany({
    select: { id: true },
    where: { team: { memberships: { some: { userId } } } },
  });
  return new Set(rows.map((r: { id: string }) => r.id));
}

export const epicRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: {
        body: CreateEpicSchema,
      },
    },
    async (request, reply) => {
      const { externalTicketId, description, repoIds } = request.body;
      const user = requireUser(request);

      // Validate all repos exist and are active. Include the requesting user's
      // team membership per repo so the access check below doesn't need a
      // second round-trip (mirrors the single-repo work-request route).
      const repos = await fastify.prisma.connection.findMany({
        select: {
          id: true,
          organizationName: true,
          repoName: true,
          team: {
            select: {
              memberships: {
                select: { userId: true },
                where: { userId: user.sub },
              },
            },
          },
        },
        where: { id: { in: repoIds }, isActive: true },
      });

      const foundIds = new Set(repos.map((r) => r.id));
      const missingIds = repoIds.filter((id) => !foundIds.has(id));
      if (missingIds.length > 0) {
        return reply.status(404).send({
          error: {
            code: 'REPOS_NOT_FOUND',
            message: `Repositories not found or inactive: ${missingIds.join(', ')}`,
          },
        });
      }

      // PROD-12: non-admins may only fan an epic out across repos whose teams
      // they belong to — same policy as single-repo work requests, applied per repo.
      if (user.role !== 'ADMIN') {
        const inaccessible = repos.filter((r) => r.team.memberships.length === 0);
        if (inaccessible.length > 0) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: `You do not have access to: ${inaccessible
                .map((r) => `${r.organizationName}/${r.repoName}`)
                .join(', ')}`,
            },
          });
        }
      }

      const workRequestId = crypto.randomUUID();
      const epicWorkflowId = `${EPIC_ID_PREFIX}${externalTicketId}`;

      // Start Temporal epic workflow FIRST (idempotency gate)
      try {
        await fastify.temporal.startEpicWorkflow(epicWorkflowId, {
          description,
          epicWorkflowId,
          externalTicketId,
          repoIds,
          repos: [], // Empty — Planner Agent will decompose
          requestPayload: JSON.stringify(request.body),
          workRequestId,
        });
      } catch (err: unknown) {
        if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
          return reply.status(409).send({
            error: {
              code: 'EPIC_ALREADY_EXISTS',
              message: `Epic workflow already running for ${externalTicketId}`,
            },
          });
        }
        throw err;
      }

      // Persist work request to DB
      await fastify.prisma.workRequest.create({
        data: {
          description,
          externalTicketId,
          id: workRequestId,
          isCrossRepo: true,
          requestedById: user.sub,
          requestPayload: JSON.stringify(request.body),
        },
      });

      return reply.status(201).send({
        data: {
          // Where the dashboard should land after creation — the epic detail
          // page polls GET /epics/:epicWorkflowId (PROD-3).
          detailPath: `/epics/${encodeURIComponent(epicWorkflowId)}`,
          epicWorkflowId,
          externalTicketId,
          workRequestId,
        },
      });
    }
  );

  // List epics. Epic ActiveWorkflow rows self-register with repoId null, so
  // the team filter used elsewhere can't see them — visibility is derived from
  // the repoIds recorded in the cross-repo WorkRequest payload instead
  // (a superset of the repos the planner actually fans out to).
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListEpicsQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { limit, offset } = request.query;

      // Epics are rare — fetch a generous window and filter/paginate in JS,
      // since the repo set only exists inside the JSON payload.
      const workRequests = await fastify.prisma.workRequest.findMany({
        include: { requestedBy: { select: { email: true, id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
        where: { isCrossRepo: true },
      });

      let visible = workRequests.map((wr) => ({
        repoIds: parseRepoIdsFromPayload(wr.requestPayload),
        wr,
      }));
      if (user.role !== 'ADMIN') {
        const allowed = await accessibleRepoIds(fastify.prisma, user.sub);
        visible = visible.filter(({ repoIds }) => repoIds.some((id) => allowed.has(id)));
      }

      const page = visible.slice(offset, offset + limit);
      const epicIds = page.map(({ wr }) => `${EPIC_ID_PREFIX}${wr.externalTicketId}`);
      const epicRows = await fastify.prisma.activeWorkflow.findMany({
        select: { currentStatus: true, temporalWorkflowId: true, updatedAt: true },
        where: { temporalWorkflowId: { in: epicIds } },
      });
      const rowById = new Map(epicRows.map((r) => [r.temporalWorkflowId, r]));

      return {
        data: page.map(({ wr, repoIds }) => {
          const epicWorkflowId = `${EPIC_ID_PREFIX}${wr.externalTicketId}`;
          const row = rowById.get(epicWorkflowId);
          return {
            createdAt: wr.createdAt,
            description: wr.description,
            epicWorkflowId,
            externalTicketId: wr.externalTicketId,
            repoCount: repoIds.length,
            requestedBy: wr.requestedBy,
            // The orchestrator's row only appears after its first state update —
            // surface the gap as STARTING rather than pretending it failed.
            status: row?.currentStatus ?? 'STARTING',
            updatedAt: row?.updatedAt ?? null,
            workRequestId: wr.id,
          };
        }),
        meta: { limit, offset, total: visible.length },
      };
    }
  );

  // Epic detail: status + per-repo child workflow fan-out progress.
  //
  // What the orchestrator records (packages/worker/src/workflows/epicOrchestrator.ts):
  //  - the epic's own ActiveWorkflow row keyed by `epic-<ticket>` (repoId null),
  //  - each child runs as `RunnableWorkflow` with workflowId `<epicId>-<repoId>`;
  //    the child self-registers its own ActiveWorkflow row via updateDomainState
  //    with repoId/parentWorkflowId/assignedBranch left null.
  // So children are matched by ID convention (and parentWorkflowId, for any
  // future code path that backfills it) and the repoId is parsed back out of
  // the child's temporal workflow ID suffix.
  app.get(
    '/:workflowId',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: EpicParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { workflowId } = request.params;

      const notFound = () =>
        reply.status(404).send({
          error: { code: 'EPIC_NOT_FOUND', message: `Epic ${workflowId} not found` },
        });

      if (!workflowId.startsWith(EPIC_ID_PREFIX)) {
        return notFound();
      }
      const externalTicketId = workflowId.slice(EPIC_ID_PREFIX.length);

      const [workRequest, epicRow] = await Promise.all([
        fastify.prisma.workRequest.findFirst({
          include: { requestedBy: { select: { email: true, id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          where: { externalTicketId, isCrossRepo: true },
        }),
        fastify.prisma.activeWorkflow.findUnique({
          where: { temporalWorkflowId: workflowId },
        }),
      ]);
      if (!workRequest && !epicRow) {
        return notFound();
      }

      const childRows = await fastify.prisma.activeWorkflow.findMany({
        orderBy: { updatedAt: 'desc' },
        where: {
          OR: [
            { parentWorkflowId: workflowId },
            { temporalWorkflowId: { startsWith: `${workflowId}-` } },
          ],
        },
      });

      // The startsWith match can catch a different epic whose ticket extends
      // this one (epic-T-2's children all start with "epic-T-"). Keep only rows
      // whose suffix is exactly one repo UUID, or that explicitly point at us.
      const children = childRows.flatMap((row) => {
        const suffix = row.temporalWorkflowId.startsWith(`${workflowId}-`)
          ? row.temporalWorkflowId.slice(workflowId.length + 1)
          : null;
        const repoId = row.repoId ?? (suffix !== null && UUID_RE.test(suffix) ? suffix : null);
        if (row.parentWorkflowId !== workflowId && repoId === null) {
          return [];
        }
        return [{ repoId, row }];
      });

      const requestedRepoIds = workRequest
        ? parseRepoIdsFromPayload(workRequest.requestPayload)
        : [];
      const knownRepoIds = [
        ...new Set([
          ...requestedRepoIds,
          ...children.map((c) => c.repoId).filter((id): id is string => id !== null),
        ]),
      ];

      // Visibility: ADMIN sees all; others need at least one of the epic's
      // repos on their team. 404 (not 403) so existence isn't probeable —
      // mirrors the list endpoint's silent filtering.
      if (user.role !== 'ADMIN') {
        const allowed = await accessibleRepoIds(fastify.prisma, user.sub);
        if (!knownRepoIds.some((id) => allowed.has(id))) {
          return notFound();
        }
      }

      const repos = await fastify.prisma.connection.findMany({
        select: { id: true, organizationName: true, repoName: true },
        where: { id: { in: knownRepoIds } },
      });
      const repoById = new Map(repos.map((r) => [r.id, r]));

      interface ChildEntry {
        branch: string | null;
        organizationName: string | null;
        repoId: string | null;
        repoName: string | null;
        status: string;
        temporalWorkflowId: string | null;
        workflowId: string | null;
      }
      const childData: ChildEntry[] = children.map(({ row, repoId }) => {
        const repo = repoId ? repoById.get(repoId) : undefined;
        return {
          // assignedBranch is null for self-registered child rows — nothing
          // backfills it today, so the UI renders a placeholder.
          branch: row.assignedBranch,
          organizationName: repo?.organizationName ?? null,
          repoId,
          repoName: repo?.repoName ?? null,
          status: row.currentStatus,
          temporalWorkflowId: row.temporalWorkflowId,
          workflowId: row.id,
        };
      });

      // Requested repos with no child row yet (epic still PLANNING, or the
      // repo is queued behind a dependency) render as PENDING placeholders.
      const startedRepoIds = new Set(children.map((c) => c.repoId));
      for (const repoId of requestedRepoIds) {
        if (!startedRepoIds.has(repoId)) {
          const repo = repoById.get(repoId);
          childData.push({
            branch: null,
            organizationName: repo?.organizationName ?? null,
            repoId,
            repoName: repo?.repoName ?? null,
            status: 'PENDING',
            temporalWorkflowId: null,
            workflowId: null,
          });
        }
      }
      childData.sort((a, b) => (a.repoName ?? '').localeCompare(b.repoName ?? ''));

      return {
        data: {
          children: childData,
          createdAt: workRequest?.createdAt ?? null,
          description: workRequest?.description ?? '',
          epicWorkflowId: workflowId,
          externalTicketId,
          requestedBy: workRequest?.requestedBy ?? null,
          status: epicRow?.currentStatus ?? 'STARTING',
          updatedAt: epicRow?.updatedAt ?? null,
          workRequestId: workRequest?.id ?? null,
        },
      };
    }
  );
};
