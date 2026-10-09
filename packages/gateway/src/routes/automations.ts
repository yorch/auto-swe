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
import type { Prisma, Role } from '@auto-swe/shared';
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
import { roleMeets } from '@auto-swe/shared/config/permissions';
import { latestActivity, TEMPLATE_WEBHOOK_SOURCE } from '@auto-swe/shared/lib/automationLedger';
import { isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import { isInstallationRetired } from '@auto-swe/shared/lib/repoAccessDecision';
import { resolveIssueTrackerConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import {
  MANAGE_FORBIDDEN,
  type RepoAutomationAccess,
  repoAutomationAccess,
} from '../lib/automations/access.js';
import {
  AutomationStartError,
  automationMatches,
  connectionInclude,
  decideAndStart,
  parseFilters,
  resolveAutomationTemplate,
} from '../lib/automations/engine.js';
import { sendError } from '../lib/httpErrors.js';
import { authorizeLaunch, sendLaunchRefusal } from '../lib/launchAuthorization.js';
import { EXCLUDE_SYSTEM_TEMPLATES } from '../lib/systemTemplate.js';
import { teamMembershipFilter, templateWriteFilter } from '../lib/templateLaunch.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';

const IdParams = z.object({ id: z.string().uuid() });
const FireParams = z.object({ fireId: z.string().uuid(), id: z.string().uuid() });
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

/**
 * The newest row per key from a `groupBy` of the newest timestamp per key: one bounded fetch of
 * just those rows (Prisma has no DISTINCT ON). A tie on the timestamp keeps the first row in the
 * fetch's order.
 */
async function newestPerKey<K extends string, Row extends Record<K, string | null>>(
  heads: Array<Record<K, string | null> & { _max: Record<string, Date | null> }>,
  key: K,
  fetch: (keys: Array<Record<string, unknown>>) => Promise<Row[]>
): Promise<Map<string, Row>> {
  const keys = heads.flatMap((h) => {
    const at = Object.values(h._max)[0];
    const timeField = Object.keys(h._max)[0];
    return h[key] !== null && at && timeField ? [{ [key]: h[key], [timeField]: at }] : [];
  });
  const map = new Map<string, Row>();
  if (keys.length === 0) {
    return map;
  }
  for (const row of await fetch(keys)) {
    const k = row[key];
    if (k !== null && !map.has(k)) {
      map.set(k, row);
    }
  }
  return map;
}

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

  // GET /api/v1/automations — every automation of the kinds this route owns that the caller
  // may see, normalised for one list: event automations on reachable repositories, template
  // webhook URLs on templates they can read, and (ADMIN only) the tracker transition hook.
  // Schedules keep their own list route, permissions and live state; the dashboard merges them.
  app.get('/', { onRequest: signedIn }, async (request) => {
    const user = requireUser(request);
    const admin = user.role === 'ADMIN';

    // Scoped through the repository the caller can reach; an admin sees all.
    const automations = await fastify.prisma.automation.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        ...automationSelect,
        connection: {
          select: {
            id: true,
            organizationName: true,
            repoName: true,
            team: {
              select: {
                id: true,
                memberships: {
                  select: { role: true },
                  where: { userId: user.sub },
                },
                name: true,
              },
            },
          },
        },
      },
      where: admin ? {} : { connection: reachableConnections(user, request.repoAccessGate) },
    });
    // The newest decision of each automation in two bounded queries: a nested `take: 1` would
    // load every automation's whole (unpruned) ledger and slice it in memory.
    const lastFires = await newestPerKey(
      await fastify.prisma.automationFire.groupBy({
        _max: { createdAt: true },
        by: ['automationId'],
        where: { automationId: { in: automations.map((a) => a.id) } },
      }),
      'automationId',
      (keys) =>
        fastify.prisma.automationFire.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { automationId: true, createdAt: true, outcome: true },
          where: { OR: keys },
        })
    );
    const events = automations.map((a) => {
      const source = eventSource(a.source);
      const filters = source ? parseFilters(source, a.filters) : null;
      const role = a.connection.team.memberships[0]?.role;
      const { connection, ...automation } = a;
      const last = lastFires.get(a.id);
      return {
        automation,
        canManage: admin || role === 'LEAD' || role === 'ADMIN',
        enabled: a.enabled,
        id: a.id,
        kind: 'event' as const,
        lastActivity: last ? { at: last.createdAt, outcome: last.outcome } : null,
        name: a.name,
        repository: {
          id: connection.id,
          organizationName: connection.organizationName,
          repoName: connection.repoName,
        },
        source: a.source,
        team: { id: connection.team.id, name: connection.team.name },
        template: a.template,
        when:
          source && filters !== null
            ? `${source.label}: ${source.describe(filters)}`
            : 'an event this build does not know',
      };
    });

    // Template webhook URLs: the template's own setting, managed on its page.
    const templates = await runUnscoped(
      'template webhooks are filtered by team membership; an admin sees all',
      ['WorkflowTemplate'],
      () =>
        fastify.prisma.workflowTemplate.findMany({
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            name: true,
            status: true,
            team: { select: { id: true, name: true } },
          },
          where: {
            AND: [
              { webhookToken: { not: null } },
              teamMembershipFilter(user),
              EXCLUDE_SYSTEM_TEMPLATES,
            ],
          },
        })
    );
    const writable = new Set(
      (
        await runUnscoped(
          'narrowing templates the caller can already read to those they may edit',
          ['WorkflowTemplate'],
          () =>
            fastify.prisma.workflowTemplate.findMany({
              select: { id: true },
              where: {
                AND: [{ id: { in: templates.map((t) => t.id) } }, templateWriteFilter(user)],
              },
            })
        )
      ).map((t) => t.id)
    );
    // What came of each webhook's latest call, from the decision ledger, and only calls the
    // caller may see: a global template's webhook is called for many teams' repositories, and
    // another team's call is not theirs to see, even as a timestamp. A call on a repository
    // counts when the repository is reachable; one on none, when the template is a team's own
    // (which the caller can read only as a member).
    const teamOwned = templates.filter((t) => t.team !== null).map((t) => t.id);
    const lastWebhookCalls = await latestActivity(
      fastify.prisma,
      TEMPLATE_WEBHOOK_SOURCE,
      templates.map((t) => t.id),
      admin
        ? {}
        : {
            OR: [
              { connection: reachableConnections(user, request.repoAccessGate) },
              { connectionId: null, subjectKey: { in: teamOwned } },
            ],
          }
    );
    // Editing a webhook (regenerate, remove) also needs platform role LEAD.
    const mayEditWebhooks = roleMeets(user.role as Role, 'LEAD' as Role);
    const webhooks = templates.map((t) => {
      const last = lastWebhookCalls.get(t.id);
      return {
        canManage: mayEditWebhooks && writable.has(t.id),
        enabled: t.status === 'ACTIVE',
        id: t.id,
        kind: 'template_webhook' as const,
        lastActivity: last ? { at: last.at, outcome: last.outcome, reason: last.reason } : null,
        name: t.name,
        repository: null,
        team: t.team,
        template: { id: t.id, name: t.name },
        when: 'A POST to the template’s secret webhook URL',
      };
    });

    // The tracker transition hook: platform configuration, so ADMIN only, and not even read
    // for anyone else.
    const tracker: unknown[] = [];
    if (admin) {
      const config = await resolveIssueTrackerConfig();
      if (config.webhookTriggerStatus) {
        // One admin-only query per page load. `jira-` is a prefix of the unique workflow ID,
        // which no index serves outside C collation, so this scans `workflow_runs`.
        const last = await fastify.prisma.workflowRun.findFirst({
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          select: { startedAt: true, status: true },
          where: { workflowId: { startsWith: 'jira-' } },
        });
        tracker.push({
          canManage: true,
          enabled: Boolean(config.webhookSecret),
          id: 'issue-tracker',
          kind: 'tracker_transition' as const,
          lastActivity: last ? { at: last.startedAt, outcome: last.status } : null,
          name: 'Issue-tracker transition',
          repository: null,
          team: null,
          template: null,
          when: `A ticket moves to “${config.webhookTriggerStatus}”`,
        });
      }
    }
    return { data: [...events, ...webhooks, ...tracker] };
  });

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
          retriedAt: true,
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

  // POST /api/v1/automations/events/:id/fires/:fireId/retry — take a decision that started no
  // run again, now, from the occurrence the ledger recorded. Every limit applies as it would to
  // a delivery; the earlier decision stays in the history, marked retried.
  app.post(
    '/events/:id/fires/:fireId/retry',
    { onRequest: signedIn, schema: { params: FireParams } },
    async (request, reply) => {
      const loaded = await loadAutomation(request, reply, request.params.id);
      if (!loaded) {
        return;
      }
      const { access, row: automation, user } = loaded;
      if (!access.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', MANAGE_FORBIDDEN);
      }
      const fire = await fastify.prisma.automationFire.findFirst({
        select: { facts: true, id: true, outcome: true, repoKey: true, retriedAt: true },
        where: { automationId: automation.id, id: request.params.fireId },
      });
      if (!fire) {
        return sendError(reply, 404, 'FIRE_NOT_FOUND', 'Decision not found');
      }
      if (fire.outcome === 'STARTED' || fire.retriedAt !== null) {
        return sendError(
          reply,
          409,
          'NOT_RETRYABLE',
          fire.outcome === 'STARTED'
            ? 'The decision started a run'
            : 'The decision was already taken again'
        );
      }
      const source = eventSource(automation.source);
      const facts = source?.facts.safeParse(fire.facts);
      if (!source || !facts?.success) {
        return sendError(
          reply,
          409,
          'NOT_RETRYABLE',
          'The recorded occurrence cannot be read by this build'
        );
      }
      if (!automationMatches(source, automation, facts.data)) {
        return sendError(
          reply,
          409,
          'NOT_RETRYABLE',
          'The automation is off, or its filters no longer select this occurrence'
        );
      }
      const connection = await fastify.prisma.connection.findFirst({
        include: connectionInclude,
        where: { id: access.repo.id, isActive: true, type: 'git_repo' },
      });
      if (!connection || isInstallationRetired(connection)) {
        return sendError(reply, 409, 'REPO_INACTIVE', 'The repository is not active');
      }
      if (!(await mayLaunch(request, reply, user, access))) {
        return;
      }
      let result: Awaited<ReturnType<typeof decideAndStart>>;
      try {
        result = await decideAndStart(fastify, source, {
          automation,
          connection,
          facts: facts.data,
          now: new Date(),
          repoKey: fire.repoKey,
          retry: { fireId: fire.id, kind: 'manual' },
          startRetryDelayMs: 1_000,
        });
      } catch (err) {
        if (err instanceof AutomationStartError) {
          return sendError(reply, 503, 'AUTOMATION_START_FAILED', err.message);
        }
        throw err;
      }
      if ('duplicate' in result) {
        return sendError(reply, 409, 'NOT_RETRYABLE', 'The decision was already taken again');
      }
      if ('ignored' in result) {
        return sendError(reply, 409, 'NOT_RETRYABLE', `Nothing was decided: ${result.reason}`);
      }
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: { outcome: result.outcome, retriedFireId: fire.id },
        before: { outcome: fire.outcome },
        entityId: automation.id,
        entityType: 'Automation',
      });
      return { data: result };
    }
  );
};
