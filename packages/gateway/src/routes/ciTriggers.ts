/**
 * A repository's CI-failure triggers (docs/ci-failure-triggers.md): the rules that start the
 * CI triage template when a GitHub Actions run on the repository fails.
 *
 * Reading a repository's triggers and what they did is open to its members (the owning team
 * and the teams it is shared with). Creating, changing and removing one is management, which
 * stays with the owning team as it does for every other repository setting: ADMIN, or a LEAD
 * of the owning team. A trigger in fix mode opens pull requests on the team's repository with
 * the platform's credential, so a shared team cannot set one up.
 *
 * A trigger is WHEN (events, branch and workflow globs), GUARDS (cooldown, daily cap) and WHAT
 * (a template and its `inputs`). The inputs are the template's own declared options, checked
 * against its input schema and the CI payload contract on every save — the same check
 * (`buildCiTriggerPayload`) a fire runs.
 */

import type { Prisma } from '@auto-swe/shared';
import {
  buildCiTriggerPayload,
  CI_TRIGGER_EVENTS,
  GlobListSchema,
  SAMPLE_CI_EVENT_FIELDS,
  TriggerInputsSchema,
  triggerOptionKeys,
} from '@auto-swe/shared/lib/ciTrigger';
import { type InputSchema, isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import type { RepoAccessGate } from '@auto-swe/shared/lib/repoAccessGate';
import { isRepoMember, repoMembersSelect } from '@auto-swe/shared/lib/repoMembership';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { acceptsCiPayload, resolveTriggerTemplate } from '../lib/ciFailureTriggers.js';
import { sendError } from '../lib/httpErrors.js';
import { authorizeLaunch, sendLaunchRefusal } from '../lib/launchAuthorization.js';
import { EXCLUDE_SYSTEM_TEMPLATES } from '../lib/systemTemplate.js';
import { permissionRequirement } from '../lib/tenantScope.js';
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
  cooldownMinutes: z.number().int().min(0).max(10_080),
  enabled: z.boolean(),
  events: EventsSchema,
  /** The template's options this trigger sets; anything left out takes the template default. */
  inputs: TriggerInputsSchema,
  maxRunsPerDay: z.number().int().min(1).max(500),
  name: z.string().trim().min(1).max(100),
  templateId: z.string().uuid().nullable(),
  /** Globs over the workflow file path, e.g. `.github/workflows/ci.yml`. */
  workflowPatterns: GlobListSchema,
};

const CreateBody = z.object({
  ...TriggerFields,
  cooldownMinutes: TriggerFields.cooldownMinutes.default(30),
  enabled: TriggerFields.enabled.default(true),
  // Pushes only by default: a pull request's failure is the author's to look at first.
  events: EventsSchema.default(['push']),
  // No options: the template's defaults, which for the built-in diagnose only — a fix is an
  // explicit choice.
  inputs: TriggerInputsSchema.default({}),
  maxRunsPerDay: TriggerFields.maxRunsPerDay.default(10),
  templateId: TriggerFields.templateId.default(null),
  workflowPatterns: TriggerFields.workflowPatterns.default(['.github/workflows/**']),
});

const UpdateBody = z.object(TriggerFields).partial();

const FiresQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const triggerSelect = {
  branchPatterns: true,
  connectionId: true,
  cooldownMinutes: true,
  createdAt: true,
  createdBy: { select: { email: true, id: true, name: true } },
  enabled: true,
  events: true,
  id: true,
  inputs: true,
  maxRunsPerDay: true,
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
  async function loadRepo(id: string, user: JwtPayload, gate: RepoAccessGate | undefined) {
    const admin = user.role === 'ADMIN';
    const repo = await fastify.prisma.connection.findFirst({
      select: {
        githubApiUrl: true,
        githubUrl: true,
        id: true,
        installation: { select: { host: true, installationId: true, isActive: true } },
        isActive: true,
        organizationName: true,
        repoName: true,
        shares: repoMembersSelect({ userId: true }, { userId: user.sub }).shares,
        team: {
          select: {
            memberships: { select: { role: true, userId: true }, where: { userId: user.sub } },
            organization: { select: { monthlyBudgetUsdCents: true } },
            orgId: true,
          },
        },
        teamId: true,
        type: true,
      },
      // Under an enforcing access gate a member must also hold a current GitHub permission
      // on the repository, as for every other repository read.
      where: { id, ...(admin ? {} : permissionRequirement(user, gate)) },
    });
    if (repo?.type !== 'git_repo') {
      return null;
    }
    if (!admin && !isRepoMember(repo, user.sub)) {
      return null;
    }
    const role = repo.team.memberships[0]?.role;
    return { canManage: admin || role === 'LEAD' || role === 'ADMIN', repo };
  }

  /**
   * A trigger starts runs on the repository, so saving one that can start runs is a launch
   * decision, exactly as for a schedule: the access gate, organization membership and its
   * monthly cap. Otherwise a lead whose GitHub access was revoked could keep a trigger acting
   * on the repository. The runs use the platform credential, so the gate judges the caller's
   * own login, not a saved token. Sends the refusal and returns false.
   */
  async function mayLaunch(
    request: FastifyRequest,
    reply: FastifyReply,
    user: JwtPayload,
    repo: NonNullable<Awaited<ReturnType<typeof loadRepo>>>['repo']
  ): Promise<boolean> {
    const decision = await authorizeLaunch(fastify.prisma, user, {
      gate: request.repoAccessGate,
      log: request.log,
      repos: [repo],
      runIdentity: 'platform',
    });
    if (decision.ok) {
      return true;
    }
    await sendLaunchRefusal(reply, decision.refusal);
    return false;
  }

  /**
   * Why a trigger's template and options cannot be saved, or null when they can. The template
   * must be one a fire could start (`resolveTriggerTemplate`: active, global or the repository
   * team's own, not a system template, CI-aware; null means the built-in), and the options
   * must build a payload it and the worker accept.
   */
  async function optionsProblem(
    templateId: string | null,
    inputs: unknown,
    events: readonly string[],
    teamId: string
  ): Promise<{ code: string; message: string } | null> {
    const template = await resolveTriggerTemplate(fastify.prisma, templateId, teamId);
    if (!template) {
      return templateId
        ? {
            code: 'INVALID_TEMPLATE',
            message:
              'templateId must name an active, non-system template, global or owned by the repository team, whose input schema declares the CI triage payload (githubRunId)',
          }
        : { code: 'TEMPLATE_MISSING', message: 'The built-in CI triage template is not installed' };
    }
    // Checked as each kind of failure the trigger reacts to arrives: a pull-request failure
    // carries a pull request number and a push failure does not, so a template that requires
    // one would otherwise pass here and refuse every push.
    const samples = [
      ...(events.includes('pull_request') ? [SAMPLE_CI_EVENT_FIELDS] : []),
      ...(events.includes('push') ? [{ ...SAMPLE_CI_EVENT_FIELDS, pullRequestNumber: null }] : []),
    ];
    for (const sample of samples) {
      const built = buildCiTriggerPayload(template.inputSchema, inputs, sample);
      if (!built.ok) {
        return {
          code: 'INVALID_INPUTS',
          message: `The options do not fit the template: ${built.errors.join('; ').slice(0, 500)}`,
        };
      }
    }
    return null;
  }

  const FORBIDDEN = 'Requires ADMIN role, or LEAD membership on the repository owning team';

  // GET /api/v1/repositories/:id/ci-triggers
  app.get(
    '/:id/ci-triggers',
    { onRequest: signedIn, schema: { params: RepoParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const loaded = await loadRepo(request.params.id, user, request.repoAccessGate);
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

  // GET /api/v1/repositories/:id/ci-triggers/templates — what a trigger here may start, and
  // the options each declares, so the form is rendered from the template's own contract.
  // Those who may manage the triggers only.
  app.get(
    '/:id/ci-triggers/templates',
    { onRequest: signedIn, schema: { params: RepoParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const loaded = await loadRepo(request.params.id, user, request.repoAccessGate);
      if (!loaded) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      // The owning team's own templates are its business: a shared team's member reads the
      // triggers, not the templates they could be pointed at.
      if (!loaded.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', FORBIDDEN);
      }
      const rows = await fastify.prisma.workflowTemplate.findMany({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { description: true, id: true, inputSchema: true, name: true, teamId: true },
        where: {
          AND: [
            {
              activeVersion: { not: null },
              OR: [{ teamId: null }, { teamId: loaded.repo.teamId }],
              status: 'ACTIVE',
            },
            EXCLUDE_SYSTEM_TEMPLATES,
          ],
        },
      });
      const builtIn = await resolveTriggerTemplate(fastify.prisma, null, loaded.repo.teamId);
      const templates = rows.flatMap((t) => {
        const schema: unknown = t.inputSchema;
        if (!isInputSchema(schema) || !acceptsCiPayload(schema)) {
          return [];
        }
        const keys = triggerOptionKeys(schema);
        const options: InputSchema = {
          properties: Object.fromEntries(
            keys.flatMap((k) => (schema.properties[k] ? [[k, schema.properties[k]]] : []))
          ),
          required: (schema.required ?? []).filter((k) => keys.includes(k)),
          type: 'object',
        };
        return [
          {
            builtIn: t.id === builtIn?.id,
            description: t.description,
            id: t.id,
            name: t.name,
            options,
          },
        ];
      });
      return { data: templates };
    }
  );

  // POST /api/v1/repositories/:id/ci-triggers
  app.post(
    '/:id/ci-triggers',
    { onRequest: signedIn, schema: { body: CreateBody, params: RepoParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const loaded = await loadRepo(request.params.id, user, request.repoAccessGate);
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
      if (body.enabled && !(await mayLaunch(request, reply, user, loaded.repo))) {
        return;
      }
      const problem = await optionsProblem(
        body.templateId,
        body.inputs,
        body.events,
        loaded.repo.teamId
      );
      if (problem) {
        return sendError(reply, 400, problem.code, problem.message);
      }
      const created = await fastify.prisma.ciFailureTrigger.create({
        data: {
          ...body,
          connectionId: loaded.repo.id,
          createdById: user.sub,
          inputs: body.inputs as Prisma.InputJsonObject,
        },
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
      const loaded = await loadRepo(request.params.id, user, request.repoAccessGate);
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
      // A trigger that is off after the change cannot start runs, whatever else changed, so
      // editing a disabled trigger is not a launch decision. Anything that leaves it on is.
      const offAfter = (body.enabled ?? existing.enabled) === false;
      if (!offAfter) {
        if (!loaded.repo.isActive) {
          return sendError(reply, 409, 'REPO_INACTIVE', 'The repository is not active');
        }
        if (!(await mayLaunch(request, reply, user, loaded.repo))) {
          return;
        }
      }
      // The options are checked against the template they will run with: a new template is
      // checked against the options it inherits, and new options against the kept template.
      if (body.templateId !== undefined || body.inputs !== undefined || body.events) {
        const problem = await optionsProblem(
          body.templateId === undefined ? existing.templateId : body.templateId,
          body.inputs ?? existing.inputs,
          body.events ?? existing.events,
          loaded.repo.teamId
        );
        if (problem) {
          return sendError(reply, 400, problem.code, problem.message);
        }
      }
      const { inputs, ...rest } = body;
      const updated = await fastify.prisma.ciFailureTrigger.update({
        data: { ...rest, ...(inputs ? { inputs: inputs as Prisma.InputJsonObject } : {}) },
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
      const loaded = await loadRepo(request.params.id, user, request.repoAccessGate);
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
      const loaded = await loadRepo(request.params.id, user, request.repoAccessGate);
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
