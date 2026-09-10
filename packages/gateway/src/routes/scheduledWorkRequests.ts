import crypto from 'node:crypto';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { generateBranchName } from '@auto-swe/shared/lib/workflowId';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import type { WorkRequestScheduleInput } from '../plugins/temporal.js';
import { resolveDefaultTemplate } from './workRequests.js';

/**
 * Scheduled / recurring work requests — standing automation on top of the
 * existing RunnableWorkflow machinery (e.g. run the dependencyUpdate template
 * weekly against a repo).
 *
 * Design (see also `ScheduledWorkRequest` in schema.prisma):
 * - Each row owns one Temporal Schedule whose action starts RunnableWorkflow
 *   directly with base workflowId `sched-<rowId>`. Temporal appends the
 *   per-fire scheduled timestamp to the workflow ID, so every fire is a fresh
 *   execution with its own WorkflowRun row.
 * - Schedule action args are static, so per-fire WorkRequest rows can't be
 *   created. Instead one standing WorkRequest is created at save time and all
 *   fires' WorkflowRuns link to it. A standing "anchor" ActiveWorkflow row
 *   (temporalWorkflowId = `sched-<rowId>`, status SCHEDULED) carries the
 *   repo / branch / budget tier and gives `createOrUpdatePullRequest` a
 *   workRequestId → workflow join so repeat fires update an still-open PR
 *   instead of erroring on a duplicate branch PR.
 * - Template resolution (explicit override or team default) happens at save
 *   time — snapshot semantics, same as interactive work requests.
 */

/**
 * Conservative 5-field cron validation: numbers, `*`, ranges, steps, lists.
 * Deliberately excludes names (JAN/MON), `?`, `L`, `W`, `#`, and 6/7-field
 * variants — Temporal accepts more, but this is the safe portable subset.
 */
const CRON_FIELD = String.raw`(\*|\d{1,2})(-\d{1,2})?(/\d{1,2})?(,(\*|\d{1,2})(-\d{1,2})?(/\d{1,2})?)*`;
export const CRON_5_FIELD_RE = new RegExp(`^${CRON_FIELD}( ${CRON_FIELD}){4}$`);

const CRON_MESSAGE =
  'must be a 5-field cron expression (minute hour day-of-month month day-of-week) using numbers, *, ranges, steps and lists only';

const BudgetTierSchema = z.enum(['STANDARD', 'LARGE', 'EPIC']);

const CreateScheduleSchema = z.object({
  budgetTier: BudgetTierSchema.optional().default('STANDARD'),
  cronExpression: z.string().regex(CRON_5_FIELD_RE, CRON_MESSAGE),
  description: z.string().min(1, 'description is required — tell the agent what to do each fire'),
  externalTicketPrefix: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'prefix must be alphanumeric, starting with a letter'),
  isActive: z.boolean().optional().default(true),
  name: z.string().min(1).max(200),
  repoId: z.string().uuid(),
  /** Explicit template override; omitted → repo team default at save time. */
  templateId: z.string().uuid().optional(),
  /** Pin a version; omitted with templateId → that template's activeVersion. */
  templateVersion: z.number().int().min(1).optional(),
});

const UpdateScheduleSchema = z.object({
  budgetTier: BudgetTierSchema.optional(),
  cronExpression: z.string().regex(CRON_5_FIELD_RE, CRON_MESSAGE).optional(),
  description: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  name: z.string().min(1).max(200).optional(),
  /** Set to null to clear an override and fall back to the team default. */
  templateId: z.string().uuid().nullable().optional(),
  templateVersion: z.number().int().min(1).nullable().optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

type Prisma = FastifyInstance['prisma'];

interface RepoWithMembership {
  id: string;
  isActive: boolean;
  organizationName: string;
  repoName: string;
  teamId: string;
  team: { memberships: Array<{ role: string; userId: string }> };
}

async function loadRepoWithMembership(
  prisma: Prisma,
  repoId: string,
  userId: string
): Promise<RepoWithMembership | null> {
  // findFirst (not findUnique) so we can scope to git_repo — a scheduled work
  // request only targets git repos; a non-git id (e.g. mcp) resolves to null and
  // the caller rejects it like a missing/forbidden repo.
  return (await prisma.connection.findFirst({
    include: {
      team: {
        select: {
          memberships: { select: { role: true, userId: true }, where: { userId } },
        },
      },
    },
    where: { id: repoId, type: 'git_repo' },
  })) as RepoWithMembership | null;
}

/** ADMIN platform role, or LEAD/ADMIN membership on the repo's team. */
function canManage(user: { role: string }, repo: RepoWithMembership): boolean {
  if (user.role === 'ADMIN') {
    return true;
  }
  const membership = repo.team.memberships[0];
  return !!membership && (membership.role === 'LEAD' || membership.role === 'ADMIN');
}

/**
 * Resolve the template snapshot for a schedule: explicit override when set,
 * otherwise the repo team's default (same resolution as POST /work-requests).
 * Returns an error string when nothing resolvable is configured.
 */
async function resolveScheduleTemplate(
  prisma: Prisma,
  repo: { teamId: string },
  templateId: string | null,
  templateVersion: number | null,
  ticketId: string
): Promise<{ templateId: string; templateVersion: number } | { error: string }> {
  if (templateId) {
    const tpl = await prisma.workflowTemplate.findUnique({ where: { id: templateId } });
    if (!tpl) {
      return { error: `Template ${templateId} not found` };
    }
    const version = templateVersion ?? tpl.activeVersion;
    if (!version) {
      return { error: `Template ${templateId} has no active version` };
    }
    const versionRow = await prisma.workflowTemplateVersion.findUnique({
      where: { templateId_version: { templateId, version } },
    });
    if (!versionRow) {
      return { error: `Template ${templateId} has no version ${version}` };
    }
    return { templateId, templateVersion: version };
  }
  const resolved = await resolveDefaultTemplate(prisma, repo.teamId, ticketId);
  if (!resolved) {
    return { error: 'No default workflow template configured for this team' };
  }
  return { templateId: resolved.templateId, templateVersion: resolved.version };
}

interface ScheduleRowForSync {
  id: string;
  cronExpression: string;
  isActive: boolean;
  budgetTier: string;
  description: string;
  externalTicketPrefix: string;
  repoId: string;
  workRequestId: string | null;
  name: string;
}

/** Synthetic ticket ID for a schedule (static — schedule args can't vary per fire). */
function scheduleTicketId(prefix: string, scheduleRowId: string): string {
  return `${prefix}-SCHED-${scheduleRowId.slice(0, 8)}`;
}

/** Compose the static Temporal Schedule input from a schedule row. */
function buildScheduleInput(
  row: ScheduleRowForSync,
  template: { templateId: string; templateVersion: number },
  workRequestId: string
): WorkRequestScheduleInput {
  const request: RepoWorkRequest = {
    budgetTier: row.budgetTier as RepoWorkRequest['budgetTier'],
    description: row.description,
    externalTicketId: scheduleTicketId(row.externalTicketPrefix, row.id),
    repoId: row.repoId,
    requestPayload: JSON.stringify({
      name: row.name,
      scheduledWorkRequestId: row.id,
      source: 'schedule',
    }),
    workRequestId,
  };
  return {
    cronExpression: row.cronExpression,
    paused: !row.isActive,
    request,
    scheduleRowId: row.id,
    templateId: template.templateId,
    templateVersion: template.templateVersion,
  };
}

const scheduleInclude = {
  createdBy: { select: { email: true, id: true, name: true } },
  repository: { select: { id: true, organizationName: true, repoName: true } },
  template: { select: { id: true, name: true } },
} as const;

// biome-ignore lint/suspicious/noExplicitAny: row shape comes from the include above; serialized explicitly
function serializeSchedule(row: any, schedule: unknown) {
  return {
    budgetTier: row.budgetTier,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    cronExpression: row.cronExpression,
    description: row.description,
    externalTicketId: scheduleTicketId(row.externalTicketPrefix, row.id),
    externalTicketPrefix: row.externalTicketPrefix,
    id: row.id,
    isActive: row.isActive,
    lastFiredAt: row.lastFiredAt,
    name: row.name,
    repository: row.repository,
    schedule,
    template: row.template,
    templateVersion: row.templateVersion,
    updatedAt: row.updatedAt,
    workRequestId: row.workRequestId,
  };
}

export const scheduledWorkRequestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // List schedules. Admins see everything; everyone else sees schedules for
  // repos on teams they belong to. Live next/last-fire info comes from the
  // Temporal Schedule (best-effort — DB columns are only bookkeeping).
  app.get('/', { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) }, async (request) => {
    const user = requireUser(request);
    const rows = await fastify.prisma.scheduledWorkRequest.findMany({
      include: scheduleInclude,
      orderBy: { createdAt: 'desc' },
      where:
        user.role === 'ADMIN'
          ? {}
          : { repository: reachableConnections(user, request.repoAccessGate) },
    });
    const statuses = await Promise.all(
      rows.map(async (row) => {
        try {
          return await fastify.temporal.getWorkRequestScheduleStatus(row.id);
        } catch {
          return { exists: false, lastRunAt: null, nextRunAt: null, paused: false };
        }
      })
    );
    return { data: rows.map((row, i) => serializeSchedule(row, statuses[i])) };
  });

  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: CreateScheduleSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body;

      const repo = await loadRepoWithMembership(fastify.prisma, body.repoId, user.sub);
      if (!repo?.isActive) {
        return reply.status(404).send({
          error: {
            code: 'REPO_NOT_FOUND',
            message: `Repository ${body.repoId} not found or inactive`,
          },
        });
      }
      if (!canManage(user, repo)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Requires ADMIN role or LEAD membership on the repository team',
          },
        });
      }

      // IDs generated upfront: the synthetic ticket / branch / Temporal
      // schedule ID all derive from the schedule row ID.
      const scheduleId = crypto.randomUUID();
      const workRequestId = crypto.randomUUID();
      const ticketId = scheduleTicketId(body.externalTicketPrefix, scheduleId);

      const template = await resolveScheduleTemplate(
        fastify.prisma,
        repo,
        body.templateId ?? null,
        body.templateVersion ?? null,
        ticketId
      );
      if ('error' in template) {
        return reply
          .status(422)
          .send({ error: { code: 'TEMPLATE_NOT_RESOLVABLE', message: template.error } });
      }

      const { branchPrefix } = await resolveWorkflowDefaults();
      const branch = generateBranchName(ticketId, branchPrefix);

      // Standing WorkRequest — every fire's WorkflowRun links to it, so
      // scheduled runs are attributable in /runs and the work-request list.
      // All three rows land in one transaction: a failure on the second or
      // third create must not leave an orphan RunInput/ActiveWorkflow behind.
      const runInputCreate = fastify.prisma.runInput.create({
        data: {
          description: body.description,
          externalTicketId: ticketId,
          id: workRequestId,
          requestedById: user.sub,
          requestPayload: JSON.stringify({
            name: body.name,
            scheduledWorkRequestId: scheduleId,
            source: 'schedule',
          }),
          templateId: template.templateId,
          templateVersion: template.templateVersion,
        },
      });

      // Anchor ActiveWorkflow row. Its temporalWorkflowId is the schedule's
      // BASE workflow ID, which no real fire uses (fires get a timestamp
      // suffix), so it never collides. It exists so worker activities that
      // join workRequestId → ActiveWorkflow (PR reuse, budget display) find a
      // row carrying the repo / branch / budget tier.
      const activeWorkflowCreate = fastify.prisma.activeWorkflow.create({
        data: {
          assignedBranch: branch,
          budgetTier: body.budgetTier,
          currentStatus: 'SCHEDULED',
          repoId: repo.id,
          temporalWorkflowId: `sched-${scheduleId}`,
          workRequestId,
        },
      });

      const scheduleCreate = fastify.prisma.scheduledWorkRequest.create({
        data: {
          budgetTier: body.budgetTier,
          createdById: user.sub,
          cronExpression: body.cronExpression,
          description: body.description,
          externalTicketPrefix: body.externalTicketPrefix,
          id: scheduleId,
          isActive: body.isActive,
          name: body.name,
          repoId: repo.id,
          templateId: body.templateId ?? null,
          templateVersion: body.templateId ? template.templateVersion : null,
          workRequestId,
        },
        include: scheduleInclude,
      });
      const [, , row] = await fastify.prisma.$transaction([
        runInputCreate,
        activeWorkflowCreate,
        scheduleCreate,
      ]);

      try {
        await fastify.temporal.syncWorkRequestSchedule(
          buildScheduleInput(row, template, workRequestId)
        );
      } catch (err) {
        // Roll back the rows so a Temporal outage doesn't leave a schedule
        // row with no backing Temporal Schedule (the inverse — a zombie
        // schedule firing against missing rows — would be much worse).
        request.log.error({ err }, 'failed to create Temporal schedule; rolling back');
        await fastify.prisma.$transaction([
          fastify.prisma.scheduledWorkRequest.delete({ where: { id: scheduleId } }),
          fastify.prisma.activeWorkflow.deleteMany({
            where: { temporalWorkflowId: `sched-${scheduleId}` },
          }),
          fastify.prisma.runInput.delete({ where: { id: workRequestId } }),
        ]);
        return reply.status(502).send({
          error: { code: 'SCHEDULE_SYNC_FAILED', message: 'Could not create Temporal schedule' },
        });
      }

      const status = await fastify.temporal.getWorkRequestScheduleStatus(scheduleId).catch(() => ({
        exists: true,
        lastRunAt: null,
        nextRunAt: null,
        paused: !body.isActive,
      }));
      return reply.status(201).send({ data: serializeSchedule(row, status) });
    }
  );

  app.patch(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: UpdateScheduleSchema, params: IdParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.scheduledWorkRequest.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'SCHEDULE_NOT_FOUND', message: 'Scheduled work request not found' },
        });
      }
      const repo = await loadRepoWithMembership(fastify.prisma, existing.repoId, user.sub);
      if (!repo) {
        return reply.status(404).send({
          error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
        });
      }
      if (!canManage(user, repo)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Requires ADMIN role or LEAD membership on the repository team',
          },
        });
      }

      if (!existing.workRequestId) {
        // Standing WorkRequest was deleted out-of-band — the schedule can no
        // longer fire safely (RunnableWorkflow would FK-fail). Recreate it.
        return reply.status(409).send({
          error: {
            code: 'SCHEDULE_ORPHANED',
            message: 'Standing work request is missing; delete and recreate this schedule',
          },
        });
      }

      const body = request.body;
      // `templateId: null` clears the override (→ team default); omitted keeps it.
      const nextTemplateId = body.templateId === undefined ? existing.templateId : body.templateId;
      const nextTemplateVersion =
        body.templateId === undefined && body.templateVersion === undefined
          ? existing.templateVersion
          : (body.templateVersion ?? null);

      const ticketId = scheduleTicketId(existing.externalTicketPrefix, existing.id);
      const template = await resolveScheduleTemplate(
        fastify.prisma,
        repo,
        nextTemplateId,
        nextTemplateVersion,
        ticketId
      );
      if ('error' in template) {
        return reply
          .status(422)
          .send({ error: { code: 'TEMPLATE_NOT_RESOLVABLE', message: template.error } });
      }

      const row = await fastify.prisma.scheduledWorkRequest.update({
        data: {
          ...(body.budgetTier !== undefined ? { budgetTier: body.budgetTier } : {}),
          ...(body.cronExpression !== undefined ? { cronExpression: body.cronExpression } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          templateId: nextTemplateId,
          templateVersion: nextTemplateId ? template.templateVersion : null,
        },
        include: scheduleInclude,
        where: { id: existing.id },
      });

      // Keep the standing WorkRequest's description/template snapshot in step
      // so the /runs attribution stays truthful.
      if (row.workRequestId) {
        await fastify.prisma.runInput.update({
          data: {
            description: row.description,
            templateId: template.templateId,
            templateVersion: template.templateVersion,
          },
          where: { id: row.workRequestId },
        });
      }

      try {
        await fastify.temporal.syncWorkRequestSchedule(
          buildScheduleInput(row, template, existing.workRequestId)
        );
      } catch (err) {
        request.log.error({ err }, 'failed to sync Temporal schedule after update');
        return reply.status(502).send({
          error: { code: 'SCHEDULE_SYNC_FAILED', message: 'Could not update Temporal schedule' },
        });
      }

      const status = await fastify.temporal
        .getWorkRequestScheduleStatus(row.id)
        .catch(() => ({ exists: true, lastRunAt: null, nextRunAt: null, paused: !row.isActive }));
      return reply.send({ data: serializeSchedule(row, status) });
    }
  );

  // Fire immediately — triggers the Temporal Schedule, which exercises the
  // exact same RunnableWorkflow path as a cron fire (SKIP overlap: dropped if
  // a previous fire is still running).
  app.post(
    '/:id/fire',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: IdParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.scheduledWorkRequest.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'SCHEDULE_NOT_FOUND', message: 'Scheduled work request not found' },
        });
      }
      const repo = await loadRepoWithMembership(fastify.prisma, existing.repoId, user.sub);
      if (!repo || !canManage(user, repo)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Requires ADMIN role or LEAD membership on the repository team',
          },
        });
      }

      try {
        await fastify.temporal.triggerWorkRequestSchedule(existing.id);
      } catch (err) {
        request.log.error({ err }, 'failed to trigger schedule');
        return reply.status(502).send({
          error: {
            code: 'SCHEDULE_TRIGGER_FAILED',
            message: 'Could not trigger Temporal schedule',
          },
        });
      }
      await fastify.prisma.scheduledWorkRequest.update({
        data: { lastFiredAt: new Date() },
        where: { id: existing.id },
      });
      return reply.status(202).send({ data: { triggered: true } });
    }
  );

  // Delete the schedule + its Temporal Schedule. The standing WorkRequest and
  // historical WorkflowRuns are intentionally kept — they're audit history.
  app.delete(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: IdParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.scheduledWorkRequest.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'SCHEDULE_NOT_FOUND', message: 'Scheduled work request not found' },
        });
      }
      const repo = await loadRepoWithMembership(fastify.prisma, existing.repoId, user.sub);
      if (!repo || !canManage(user, repo)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Requires ADMIN role or LEAD membership on the repository team',
          },
        });
      }

      // Temporal first (idempotent — only not-found is swallowed), then the
      // row. If Temporal is unreachable the row must survive: deleting it
      // would orphan a live schedule that keeps starting runs nothing can stop.
      try {
        await fastify.temporal.deleteWorkRequestSchedule(existing.id);
      } catch (err) {
        request.log.error({ err, scheduleId: existing.id }, 'failed to delete Temporal schedule');
        return reply.status(502).send({
          error: {
            code: 'SCHEDULE_SYNC_FAILED',
            message: 'Could not remove the Temporal schedule; the scheduled request was kept',
          },
        });
      }
      await fastify.prisma.scheduledWorkRequest.delete({ where: { id: existing.id } });
      return reply.send({ data: { deleted: true } });
    }
  );
};
