/**
 * Event automations (docs/automations.md): rules on a repository that start a template run
 * when an occurrence of an event source matches — `github.workflow_run.failed` is the CI-failure
 * trigger. An automation is WHEN (its source's filters), LIMITS (cooldown, daily cap) and WHAT
 * (a template and its `inputs`, the template's own declared options), checked on every save by
 * the same builder a fire runs (`buildAutomationPayload`).
 *
 * Reading a repository's automations and what they decided is open to its members; managing
 * them is ADMIN, or a LEAD of the owning team (`repoAutomationAccess`). Saving one that can
 * start runs is a launch decision, as for a schedule.
 */
import type { Prisma } from '@auto-swe/shared';
import {
  AutomationInputsSchema,
  automationOptionsProblem,
  EVENT_SOURCE_KEYS,
  type EventSource,
  eventSource,
  optionsSchema,
  storedInputs,
} from '@auto-swe/shared/automation';
import { resolveSetting } from '@auto-swe/shared/config';
import { isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import {
  MANAGE_FORBIDDEN,
  type RepoAutomationAccess,
  repoAutomationAccess,
} from '../lib/automations/access.js';
import { parseFilters, resolveAutomationTemplate } from '../lib/automations/engine.js';
import { sendError } from '../lib/httpErrors.js';
import { authorizeLaunch, sendLaunchRefusal } from '../lib/launchAuthorization.js';
import { EXCLUDE_SYSTEM_TEMPLATES } from '../lib/systemTemplate.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';

const IdParams = z.object({ id: z.string().uuid() });
const ListQuery = z.object({ connectionId: z.string().uuid() });
const TemplatesQuery = z.object({
  connectionId: z.string().uuid(),
  source: z.enum(EVENT_SOURCE_KEYS as [string, ...string[]]),
});
const FiresQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const Fields = {
  cooldownMinutes: z.number().int().min(0).max(10_080),
  enabled: z.boolean(),
  /** The source's filters; checked against the source's own schema. */
  filters: z.record(z.string(), z.unknown()),
  /** The template's options; anything left out takes the template default. */
  inputs: AutomationInputsSchema,
  maxRunsPerDay: z.number().int().min(1).max(500),
  name: z.string().trim().min(1).max(100),
  templateId: z.string().uuid().nullable(),
};

const CreateBody = z.object({
  ...Fields,
  connectionId: z.string().uuid(),
  cooldownMinutes: Fields.cooldownMinutes.default(30),
  enabled: Fields.enabled.default(true),
  // No options: the template's defaults, which for the built-in CI template diagnose only.
  inputs: AutomationInputsSchema.default({}),
  maxRunsPerDay: Fields.maxRunsPerDay.default(10),
  source: z.enum(EVENT_SOURCE_KEYS as [string, ...string[]]),
  templateId: Fields.templateId.default(null),
});
const UpdateBody = z.object(Fields).partial();

const automationSelect = {
  connectionId: true,
  cooldownMinutes: true,
  createdAt: true,
  createdBy: { select: { email: true, id: true, name: true } },
  enabled: true,
  filters: true,
  id: true,
  inputs: true,
  maxRunsPerDay: true,
  name: true,
  source: true,
  template: { select: { id: true, name: true } },
  templateId: true,
  updatedAt: true,
} as const;

export const automationRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const signedIn = requireAuth({ requiredRole: 'ENGINEER' });

  /**
   * An automation starts runs on the repository, so saving one that can start runs is a launch
   * decision, exactly as for a schedule: the access gate, organization membership and its
   * monthly cap. The runs use the platform credential, so the gate judges the caller's own
   * login, not a saved token. Sends the refusal and returns false.
   */
  async function mayLaunch(
    request: FastifyRequest,
    reply: FastifyReply,
    user: JwtPayload,
    access: RepoAutomationAccess
  ): Promise<boolean> {
    const decision = await authorizeLaunch(fastify.prisma, user, {
      gate: request.repoAccessGate,
      log: request.log,
      repos: [access.repo],
      runIdentity: 'platform',
    });
    if (decision.ok) {
      return true;
    }
    await sendLaunchRefusal(reply, decision.refusal);
    return false;
  }

  /**
   * Why an automation cannot be saved, or null when it can: its filters must parse as the
   * source's, a gated option value needs its conditions, the template must be one a fire could
   * start, and the options must build a payload it accepts for every shape of occurrence the
   * filters select.
   */
  async function saveProblem(
    source: EventSource<unknown, unknown>,
    body: { filters: unknown; inputs: unknown; templateId: string | null },
    access: RepoAutomationAccess
  ): Promise<{ code: string; message: string } | null> {
    const filters = parseFilters(source, body.filters);
    if (filters === null) {
      const parsed = source.filters.safeParse(body.filters);
      return {
        code: 'INVALID_FILTERS',
        message: `The filters do not fit ${source.label}: ${
          parsed.success
            ? 'unreadable'
            : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        }`.slice(0, 500),
      };
    }
    const inputs = storedInputs(body.inputs);
    for (const gate of source.gatedOptions ?? []) {
      if (!gate.values.includes(inputs[gate.key])) {
        continue;
      }
      if (gate.defaultTemplateOnly && body.templateId !== null) {
        return {
          code: 'INVALID_INPUTS',
          message: `'${gate.key}: ${String(inputs[gate.key])}' is available only with the default template`,
        };
      }
      const orgId = access.repo.team.orgId;
      const allowed = await resolveSetting(gate.setting, {
        ...(orgId ? { orgId } : {}),
        teamId: access.repo.teamId,
      });
      if (allowed !== true) {
        return { code: 'OPTION_DISABLED', message: gate.disabledMessage };
      }
    }
    const template = await resolveAutomationTemplate(
      fastify.prisma,
      source,
      body.templateId,
      access.repo.teamId
    );
    if (!template) {
      return body.templateId
        ? {
            code: 'INVALID_TEMPLATE',
            message: `templateId must name an active, non-system template, global or owned by the repository team, that ${source.label} can start`,
          }
        : {
            code: 'TEMPLATE_MISSING',
            message: `The default template (${source.defaultTemplate.name}) is not installed`,
          };
    }
    const problem = automationOptionsProblem(source, filters, template.inputSchema, body.inputs);
    return problem
      ? {
          code: 'INVALID_INPUTS',
          message: `The options do not fit the template: ${problem.slice(0, 500)}`,
        }
      : null;
  }

  /** The automation and its repository's access, or a reply already sent. */
  async function loadAutomation(request: FastifyRequest, reply: FastifyReply, id: string) {
    const user = requireUser(request);
    const row = await fastify.prisma.automation.findUnique({
      select: automationSelect,
      where: { id },
    });
    const access = row
      ? await repoAutomationAccess(fastify.prisma, row.connectionId, user, request.repoAccessGate)
      : null;
    if (!row || !access) {
      await sendError(reply, 404, 'AUTOMATION_NOT_FOUND', 'Automation not found');
      return null;
    }
    return { access, row, user };
  }

  // GET /api/v1/automations/events?connectionId= — a repository's event automations.
  app.get(
    '/events',
    { onRequest: signedIn, schema: { querystring: ListQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const access = await repoAutomationAccess(
        fastify.prisma,
        request.query.connectionId,
        user,
        request.repoAccessGate
      );
      if (!access) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      const automations = await fastify.prisma.automation.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: automationSelect,
        where: { connectionId: access.repo.id },
      });
      return { data: { automations, canManage: access.canManage } };
    }
  );

  // GET /api/v1/automations/events/templates?connectionId=&source= — what an automation of
  // that source on that repository may start, with the options each declares. Managers only:
  // the owning team's own templates are its business.
  app.get(
    '/events/templates',
    { onRequest: signedIn, schema: { querystring: TemplatesQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const access = await repoAutomationAccess(
        fastify.prisma,
        request.query.connectionId,
        user,
        request.repoAccessGate
      );
      if (!access) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      if (!access.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', MANAGE_FORBIDDEN);
      }
      const source = eventSource(request.query.source);
      if (!source) {
        return sendError(reply, 400, 'UNKNOWN_SOURCE', 'Unknown event source');
      }
      const rows = await fastify.prisma.workflowTemplate.findMany({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { description: true, id: true, inputSchema: true, name: true },
        where: {
          AND: [
            {
              activeVersion: { not: null },
              OR: [{ teamId: null }, { teamId: access.repo.teamId }],
              status: 'ACTIVE',
            },
            EXCLUDE_SYSTEM_TEMPLATES,
          ],
        },
      });
      const fallback = await resolveAutomationTemplate(
        fastify.prisma,
        source,
        null,
        access.repo.teamId
      );
      const templates = rows.flatMap((t) => {
        const schema: unknown = t.inputSchema;
        if (!isInputSchema(schema) || !source.templateCompatible(schema)) {
          return [];
        }
        return [
          {
            builtIn: t.id === fallback?.id,
            description: t.description,
            id: t.id,
            name: t.name,
            options: optionsSchema(schema, source),
          },
        ];
      });
      return { data: templates };
    }
  );

  // POST /api/v1/automations/events
  app.post(
    '/events',
    { onRequest: signedIn, schema: { body: CreateBody } },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body;
      const access = await repoAutomationAccess(
        fastify.prisma,
        body.connectionId,
        user,
        request.repoAccessGate
      );
      if (!access) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      if (!access.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', MANAGE_FORBIDDEN);
      }
      if (!access.repo.isActive) {
        return sendError(reply, 409, 'REPO_INACTIVE', 'The repository is not active');
      }
      const source = eventSource(body.source);
      if (!source) {
        return sendError(reply, 400, 'UNKNOWN_SOURCE', 'Unknown event source');
      }
      if (body.enabled && !(await mayLaunch(request, reply, user, access))) {
        return;
      }
      const problem = await saveProblem(source, body, access);
      if (problem) {
        return sendError(reply, 400, problem.code, problem.message);
      }
      const created = await fastify.prisma.automation.create({
        data: {
          connectionId: access.repo.id,
          cooldownMinutes: body.cooldownMinutes,
          createdById: user.sub,
          enabled: body.enabled,
          // Stored as the source parsed it (deduplicated, trimmed).
          filters: parseFilters(source, body.filters) as Prisma.InputJsonObject,
          inputs: body.inputs as Prisma.InputJsonObject,
          maxRunsPerDay: body.maxRunsPerDay,
          name: body.name,
          source: source.key,
          templateId: body.templateId,
        },
        select: automationSelect,
      });
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor: user,
        after: created,
        entityId: created.id,
        entityType: 'Automation',
      });
      return reply.status(201).send({ data: created });
    }
  );

  // PATCH /api/v1/automations/events/:id
  app.patch(
    '/events/:id',
    { onRequest: signedIn, schema: { body: UpdateBody, params: IdParams } },
    async (request, reply) => {
      const loaded = await loadAutomation(request, reply, request.params.id);
      if (!loaded) {
        return;
      }
      const { access, row: existing, user } = loaded;
      if (!access.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', MANAGE_FORBIDDEN);
      }
      const source = eventSource(existing.source);
      if (!source) {
        return sendError(reply, 409, 'UNKNOWN_SOURCE', 'The automation names an unknown source');
      }
      const body = request.body;
      // An automation that is off after the change cannot start runs, whatever else changed,
      // so editing a disabled one is not a launch decision. Anything that leaves it on is.
      if ((body.enabled ?? existing.enabled) !== false) {
        if (!access.repo.isActive) {
          return sendError(reply, 409, 'REPO_INACTIVE', 'The repository is not active');
        }
        if (!(await mayLaunch(request, reply, user, access))) {
          return;
        }
      }
      // Template, options and filters are checked together, as they will run.
      if (
        body.templateId !== undefined ||
        body.inputs !== undefined ||
        body.filters !== undefined
      ) {
        const problem = await saveProblem(
          source,
          {
            filters: body.filters ?? existing.filters,
            inputs: body.inputs ?? existing.inputs,
            templateId: body.templateId === undefined ? existing.templateId : body.templateId,
          },
          access
        );
        if (problem) {
          return sendError(reply, 400, problem.code, problem.message);
        }
      }
      const { filters, inputs, ...rest } = body;
      const updated = await fastify.prisma.automation.update({
        data: {
          ...rest,
          ...(filters ? { filters: parseFilters(source, filters) as Prisma.InputJsonObject } : {}),
          ...(inputs ? { inputs: inputs as Prisma.InputJsonObject } : {}),
        },
        select: automationSelect,
        where: { id: existing.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: updated,
        before: existing,
        entityId: existing.id,
        entityType: 'Automation',
      });
      return { data: updated };
    }
  );

  // DELETE /api/v1/automations/events/:id — its decisions stay in the repository's ledger,
  // which the limits keep reading.
  app.delete(
    '/events/:id',
    { onRequest: signedIn, schema: { params: IdParams } },
    async (request, reply) => {
      const loaded = await loadAutomation(request, reply, request.params.id);
      if (!loaded) {
        return;
      }
      if (!loaded.access.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', MANAGE_FORBIDDEN);
      }
      await fastify.prisma.automation.delete({ where: { id: loaded.row.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor: loaded.user,
        before: loaded.row,
        entityId: loaded.row.id,
        entityType: 'Automation',
      });
      return reply.status(204).send();
    }
  );

  // GET /api/v1/automations/events/:id/fires — what the automation decided.
  app.get(
    '/events/:id/fires',
    { onRequest: signedIn, schema: { params: IdParams, querystring: FiresQuery } },
    async (request, reply) => {
      const loaded = await loadAutomation(request, reply, request.params.id);
      if (!loaded) {
        return;
      }
      const fires = await fastify.prisma.automationFire.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          createdAt: true,
          facts: true,
          id: true,
          outcome: true,
          reason: true,
          scopeKey: true,
          subjectKey: true,
          temporalWorkflowId: true,
          workRequestId: true,
        },
        take: request.query.limit,
        where: { automationId: loaded.row.id },
      });
      return { data: { fires } };
    }
  );
};
