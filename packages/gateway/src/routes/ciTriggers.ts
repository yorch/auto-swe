/**
 * A repository's CI-failure triggers (docs/ci-failure-triggers.md): the rules that start the
 * CI triage template when a GitHub Actions run on the repository fails.
 *
 * Reading a repository's triggers and what they did is open to its members (the owning team
 * and the teams it is shared with). Creating, changing and removing one is management, which
 * stays with the owning team as it does for every other repository setting: ADMIN, or a LEAD
 * of the owning team. A trigger in FIX mode opens pull requests on the team's repository with
 * the platform's credential, so a shared team cannot set one up.
 */
import {
  CI_TRIGGER_EVENTS,
  CI_TRIGGER_MODES,
  GlobListSchema,
} from '@auto-swe/shared/lib/ciTrigger';
import { isRepoMember, repoMembersSelect } from '@auto-swe/shared/lib/repoMembership';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';

const RepoParams = z.object({ id: z.string().uuid() });
const TriggerParams = z.object({ id: z.string().uuid(), triggerId: z.string().uuid() });

const EventsSchema = z
  .array(z.enum(CI_TRIGGER_EVENTS))
  .min(1)
  .max(CI_TRIGGER_EVENTS.length)
  .transform((events) => [...new Set(events)]);

const TriggerFields = {
  /** Globs over the failing branch. Required: no trigger reacts to every branch by default. */
  branchPatterns: GlobListSchema,
  commentOnPullRequest: z.boolean(),
  cooldownMinutes: z.number().int().min(0).max(10_080),
  enabled: z.boolean(),
  events: EventsSchema,
  maxRunsPerDay: z.number().int().min(1).max(500),
  mode: z.enum(CI_TRIGGER_MODES),
  name: z.string().trim().min(1).max(100),
  templateId: z.string().uuid().nullable(),
  /** Globs over the workflow file path, e.g. `.github/workflows/ci.yml`. */
  workflowPatterns: GlobListSchema,
};

const CreateBody = z.object({
  ...TriggerFields,
  commentOnPullRequest: TriggerFields.commentOnPullRequest.default(true),
  cooldownMinutes: TriggerFields.cooldownMinutes.default(30),
  enabled: TriggerFields.enabled.default(true),
  // Pushes only by default: a pull request's failure is the author's to look at first.
  events: EventsSchema.default(['push']),
  maxRunsPerDay: TriggerFields.maxRunsPerDay.default(10),
  // Diagnose only by default; a fix is an explicit choice.
  mode: TriggerFields.mode.default('TRIAGE_ONLY'),
  templateId: TriggerFields.templateId.default(null),
  workflowPatterns: TriggerFields.workflowPatterns.default(['.github/workflows/**']),
});

const UpdateBody = z.object(TriggerFields).partial();

const FiresQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const triggerSelect = {
  branchPatterns: true,
  commentOnPullRequest: true,
  connectionId: true,
  cooldownMinutes: true,
  createdAt: true,
  createdBy: { select: { email: true, id: true, name: true } },
  enabled: true,
  events: true,
  id: true,
  maxRunsPerDay: true,
  mode: true,
  name: true,
  template: { select: { id: true, name: true } },
  templateId: true,
  updatedAt: true,
  workflowPatterns: true,
} as const;

export const ciTriggerRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const signedIn = requireAuth({ requiredRole: 'ENGINEER' });

  /**
   * The repository a trigger route acts on, with whether the caller may read it (a member,
   * or ADMIN) and manage its triggers (ADMIN, or a LEAD of the owning team). Null when it is
   * not a git repository or the caller may not read it — answered 404 either way, so the
   * route does not confirm a repository the caller cannot see.
   */
  async function loadRepo(id: string, user: JwtPayload) {
    const repo = await fastify.prisma.connection.findUnique({
      select: {
        id: true,
        isActive: true,
        shares: repoMembersSelect({ userId: true }, { userId: user.sub }).shares,
        team: {
          select: {
            memberships: { select: { role: true, userId: true }, where: { userId: user.sub } },
          },
        },
        teamId: true,
        type: true,
      },
      where: { id },
    });
    if (repo?.type !== 'git_repo') {
      return null;
    }
    const admin = user.role === 'ADMIN';
    if (!admin && !isRepoMember(repo, user.sub)) {
      return null;
    }
    const role = repo.team.memberships[0]?.role;
    return { canManage: admin || role === 'LEAD' || role === 'ADMIN', repo };
  }

  /** A template a trigger may start: active, and global or the repository team's own. */
  async function templateAllowed(templateId: string, teamId: string): Promise<boolean> {
    const row = await fastify.prisma.workflowTemplate.findFirst({
      select: { id: true },
      where: { id: templateId, OR: [{ teamId: null }, { teamId }], status: 'ACTIVE' },
    });
    return row !== null;
  }

  const FORBIDDEN = 'Requires ADMIN role, or LEAD membership on the repository owning team';

  // GET /api/v1/repositories/:id/ci-triggers
  app.get(
    '/:id/ci-triggers',
    { onRequest: signedIn, schema: { params: RepoParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const loaded = await loadRepo(request.params.id, user);
      if (!loaded) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      const triggers = await fastify.prisma.ciFailureTrigger.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: triggerSelect,
        where: { connectionId: loaded.repo.id },
      });
      return { data: { canManage: loaded.canManage, triggers } };
    }
  );

  // POST /api/v1/repositories/:id/ci-triggers
  app.post(
    '/:id/ci-triggers',
    { onRequest: signedIn, schema: { body: CreateBody, params: RepoParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const loaded = await loadRepo(request.params.id, user);
      if (!loaded) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      if (!loaded.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', FORBIDDEN);
      }
      if (!loaded.repo.isActive) {
        return sendError(reply, 409, 'REPO_INACTIVE', 'The repository is not active');
      }
      const body = request.body;
      if (body.templateId && !(await templateAllowed(body.templateId, loaded.repo.teamId))) {
        return sendError(
          reply,
          400,
          'INVALID_TEMPLATE',
          'templateId must name an active template that is global or owned by the repository team'
        );
      }
      const created = await fastify.prisma.ciFailureTrigger.create({
        data: { ...body, connectionId: loaded.repo.id, createdById: user.sub },
        select: triggerSelect,
      });
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor: user,
        after: created,
        entityId: created.id,
        entityType: 'CiFailureTrigger',
      });
      return reply.status(201).send({ data: created });
    }
  );

  // PATCH /api/v1/repositories/:id/ci-triggers/:triggerId
  app.patch(
    '/:id/ci-triggers/:triggerId',
    { onRequest: signedIn, schema: { body: UpdateBody, params: TriggerParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const loaded = await loadRepo(request.params.id, user);
      if (!loaded) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      const existing = await fastify.prisma.ciFailureTrigger.findFirst({
        select: triggerSelect,
        where: { connectionId: loaded.repo.id, id: request.params.triggerId },
      });
      if (!existing) {
        return sendError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found');
      }
      if (!loaded.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', FORBIDDEN);
      }
      const body = request.body;
      if (body.templateId && !(await templateAllowed(body.templateId, loaded.repo.teamId))) {
        return sendError(
          reply,
          400,
          'INVALID_TEMPLATE',
          'templateId must name an active template that is global or owned by the repository team'
        );
      }
      const updated = await fastify.prisma.ciFailureTrigger.update({
        data: body,
        select: triggerSelect,
        where: { id: existing.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: updated,
        before: existing,
        entityId: existing.id,
        entityType: 'CiFailureTrigger',
      });
      return { data: updated };
    }
  );

  // DELETE /api/v1/repositories/:id/ci-triggers/:triggerId — also drops its fire history.
  app.delete(
    '/:id/ci-triggers/:triggerId',
    { onRequest: signedIn, schema: { params: TriggerParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const loaded = await loadRepo(request.params.id, user);
      if (!loaded) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      const existing = await fastify.prisma.ciFailureTrigger.findFirst({
        select: triggerSelect,
        where: { connectionId: loaded.repo.id, id: request.params.triggerId },
      });
      if (!existing) {
        return sendError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found');
      }
      if (!loaded.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', FORBIDDEN);
      }
      await fastify.prisma.ciFailureTrigger.delete({ where: { id: existing.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor: user,
        before: existing,
        entityId: existing.id,
        entityType: 'CiFailureTrigger',
      });
      return reply.status(204).send();
    }
  );

  // GET /api/v1/repositories/:id/ci-triggers/:triggerId/fires — what the trigger decided.
  app.get(
    '/:id/ci-triggers/:triggerId/fires',
    { onRequest: signedIn, schema: { params: TriggerParams, querystring: FiresQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const loaded = await loadRepo(request.params.id, user);
      if (!loaded) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      const trigger = await fastify.prisma.ciFailureTrigger.findFirst({
        select: { id: true },
        where: { connectionId: loaded.repo.id, id: request.params.triggerId },
      });
      if (!trigger) {
        return sendError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found');
      }
      const fires = await fastify.prisma.ciFailureTriggerFire.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          createdAt: true,
          event: true,
          githubRunId: true,
          headBranch: true,
          headSha: true,
          id: true,
          outcome: true,
          pullRequestNumber: true,
          reason: true,
          runAttempt: true,
          temporalWorkflowId: true,
          workflowPath: true,
          workRequestId: true,
        },
        take: request.query.limit,
        where: { triggerId: trigger.id },
      });
      return { data: { fires } };
    }
  );
};
