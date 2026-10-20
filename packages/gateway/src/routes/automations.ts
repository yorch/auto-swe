/**
 * Event automations (docs/automations.md): rules that start a template run when an occurrence
 * of an event source matches — `github.workflow_run.failed` is the CI-failure trigger. An
 * automation is WHEN (its source's filters), LIMITS (cooldown, daily cap) and WHAT (a template
 * and its `inputs`, the template's own declared options), checked on every save by the same
 * builder a fire runs (`buildAutomationPayload`).
 *
 * An automation belongs to a repository or, for a source whose automations target a team, to a
 * team. Reading a repository's automations and what they decided is open to its members;
 * managing them is ADMIN, or a LEAD of the owning team (`repoAutomationAccess`). A team's are
 * read by its members and managed by ADMIN or its LEADs (`teamAutomationAccess`). Saving one
 * that can start runs is a launch decision, as for a schedule.
 */
import type { Prisma, Role } from '@auto-swe/shared';
import {
  AutomationInputsSchema,
  automationOptionsProblem,
  ENDPOINT_OWNER_KIND,
  EVENT_SOURCE_KEYS,
  type EventSource,
  eventSource,
  INBOUND_EVENT,
  type InboundEventFilters,
  isRepositoryOwnerKey,
  optionsSchema,
  parseOwnerKey,
  storedInputs,
  teamOwnerKey,
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
  type AutomationOwnerAccess,
  automationOwnerAccess,
  findLaunchRepo,
  manageForbidden,
  ownerTeam,
} from '../lib/automations/access.js';
import { declaredConnectionProblem } from '../lib/automations/declaredConnections.js';
import {
  AutomationStartError,
  automationMatches,
  connectionInclude,
  decideAndStart,
  type EngineConnection,
  type EngineTeam,
  parseFilters,
  resolveAutomationTemplate,
} from '../lib/automations/engine.js';
import { loadTargetConnection, TARGET_UNAVAILABLE } from '../lib/automations/inboundEvent.js';
import { sendError } from '../lib/httpErrors.js';
import { authorizeLaunch, sendLaunchRefusal } from '../lib/launchAuthorization.js';
import { EXCLUDE_SYSTEM_TEMPLATES } from '../lib/systemTemplate.js';
import { teamMembershipFilter, templateWriteFilter } from '../lib/templateLaunch.js';
import { signatureRequiredByPolicy } from '../lib/templateWebhookSigning.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';

/** A repository a team automation's runs act on, as a launch decision reads it. */
type TargetRepo = NonNullable<Awaited<ReturnType<typeof findLaunchRepo>>>;

const IdParams = z.object({ id: z.string().uuid() });
const FireParams = z.object({ fireId: z.string().uuid(), id: z.string().uuid() });

/** What an automation belongs to: a repository or a team, exactly one of them. */
const Owner = {
  connectionId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
};
const ONE_OWNER = {
  message: 'Name exactly one of connectionId (a repository) or teamId (a team)',
};
const oneOwner = (o: { connectionId?: string; teamId?: string }) =>
  (o.connectionId === undefined) !== (o.teamId === undefined);

const ListQuery = z.object(Owner).refine(oneOwner, ONE_OWNER);
const TemplatesQuery = z
  .object({ ...Owner, source: z.enum(EVENT_SOURCE_KEYS as [string, ...string[]]) })
  .refine(oneOwner, ONE_OWNER);
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
  /**
   * For a team automation: the repository its runs act on, one the team owns or is shared.
   * Null for runs on no repository.
   */
  targetConnectionId: z.string().uuid().nullable(),
  templateId: z.string().uuid().nullable(),
};

const CreateBody = z
  .object({
    ...Fields,
    ...Owner,
    cooldownMinutes: Fields.cooldownMinutes.default(30),
    enabled: Fields.enabled.default(true),
    // No options: the template's defaults, which for the built-in CI template diagnose only.
    inputs: AutomationInputsSchema.default({}),
    maxRunsPerDay: Fields.maxRunsPerDay.default(10),
    source: z.enum(EVENT_SOURCE_KEYS as [string, ...string[]]),
    targetConnectionId: Fields.targetConnectionId.default(null),
    templateId: Fields.templateId.default(null),
  })
  .refine(oneOwner, ONE_OWNER);
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
  targetConnection: { select: { id: true, organizationName: true, repoName: true } },
  targetConnectionId: true,
  team: { select: { id: true, name: true } },
  teamId: true,
  template: { select: { id: true, name: true } },
  templateId: true,
  updatedAt: true,
} as const;

/**
 * Why a source's automations cannot belong to this owner, or null when they can: a source
 * declares whether its automations live on a repository or on a team.
 */
function targetMismatch(
  source: EventSource<unknown, unknown>,
  owner: { connectionId?: string | null; teamId?: string | null }
): string | null {
  const onRepository = owner.connectionId !== undefined && owner.connectionId !== null;
  if (source.target === 'repository' && !onRepository) {
    return `${source.label} automations belong to a repository: name its connectionId`;
  }
  if (source.target === 'team' && onRepository) {
    return `${source.label} automations belong to a team: name its teamId`;
  }
  return null;
}

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
   * An automation starts runs, so saving one that can start runs is a launch decision, exactly
   * as for a schedule: on a repository the access gate, organization membership and its monthly
   * cap; for a team's, whose runs have no repository, membership of the team's organization and
   * its cap. The runs use the platform credential, so the gate judges the caller's own login,
   * not a saved token. Sends the refusal and returns false.
   */
  async function mayLaunch(
    request: FastifyRequest,
    reply: FastifyReply,
    user: JwtPayload,
    access: AutomationOwnerAccess,
    /** The repository a team automation's runs act on, when it names one. */
    target: TargetRepo | null = null
  ): Promise<boolean> {
    const decision = await authorizeLaunch(fastify.prisma, user, {
      gate: request.repoAccessGate,
      log: request.log,
      ...(access.kind === 'repository'
        ? { repos: [access.repo] }
        : { orgs: [access.team.organization], repos: target ? [target] : [] }),
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
    body: {
      filters: unknown;
      inputs: unknown;
      templateId: string | null;
      targetConnectionId: string | null;
    },
    access: AutomationOwnerAccess
  ): Promise<{ code: string; message: string } | null> {
    const team = ownerTeam(access);
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
    if (source.key === INBOUND_EVENT) {
      // The endpoint must be one of the automation's own team.
      const { endpointId } = filters as InboundEventFilters;
      const endpoint = await fastify.prisma.eventEndpoint.findFirst({
        select: { id: true },
        where: { id: endpointId, teamId: team.id },
      });
      if (!endpoint) {
        return {
          code: 'INVALID_FILTERS',
          message: 'endpointId must name one of the team’s event endpoints',
        };
      }
    }
    if (!body.templateId && !source.defaultTemplate) {
      return {
        code: 'TEMPLATE_REQUIRED',
        message: `${source.label} automations start the template they name: choose a templateId`,
      };
    }
    // A filter value a setting refuses, same refusal as a gated option: the fire decides
    // again (`mismatch`), but an author learns at save rather than from a dead rule.
    for (const gate of source.gatedFilters ?? []) {
      const selected = (filters as Record<string, unknown>)[gate.key];
      const chosen = Array.isArray(selected) ? selected : [selected];
      if (!chosen.some((v) => (gate.values as readonly unknown[]).includes(v))) {
        continue;
      }
      const allowed = await resolveSetting(gate.setting, {
        ...(team.orgId ? { orgId: team.orgId } : {}),
        teamId: team.id,
      });
      if (allowed !== true) {
        return { code: 'OPTION_DISABLED', message: gate.disabledMessage };
      }
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
      const allowed = await resolveSetting(gate.setting, {
        ...(team.orgId ? { orgId: team.orgId } : {}),
        teamId: team.id,
      });
      if (allowed !== true) {
        return { code: 'OPTION_DISABLED', message: gate.disabledMessage };
      }
    }
    const template = await resolveAutomationTemplate(
      fastify.prisma,
      source,
      body.templateId,
      team.id
    );
    if (!template) {
      return body.templateId
        ? {
            code: 'INVALID_TEMPLATE',
            message: `templateId must name an active, non-system template, global or owned by the ${access.kind === 'repository' ? 'repository team' : 'team'}, that ${source.label} can start`,
          }
        : {
            code: 'TEMPLATE_MISSING',
            message: `The default template (${source.defaultTemplate?.name ?? 'none'}) is not installed`,
          };
    }
    const problem = automationOptionsProblem(
      source,
      filters,
      template.inputSchema,
      body.inputs,
      access.kind === 'repository' || body.targetConnectionId !== null
    );
    if (problem) {
      return {
        code: 'INVALID_INPUTS',
        message: `The options do not fit the template: ${problem.slice(0, 500)}`,
      };
    }
    // The same decision the fire takes, on the author's own options, so a LEAD learns when they
    // save rather than from a run that never started. The fire remains the boundary: it also
    // covers a schema `default` and a field the occurrence fills, neither of which exists yet here.
    const unusable = await declaredConnectionProblem({
      inputSchema: template.inputSchema,
      payload: inputs,
      prisma: fastify.prisma,
      teamId: team.id,
    });
    return unusable
      ? { code: 'INVALID_INPUTS', message: `The options do not fit the template: ${unusable}` }
      : null;
  }

  /**
   * The repository a team automation's runs would act on, as a launch decision reads it: one
   * the team owns or is shared, active, and a git repository. Null for none; false when a refusal
   * was sent.
   */
  async function targetRepository(
    request: FastifyRequest,
    reply: FastifyReply,
    access: AutomationOwnerAccess,
    targetConnectionId: string | null
  ): Promise<TargetRepo | null | false> {
    if (targetConnectionId === null) {
      return null;
    }
    if (access.kind !== 'team') {
      await sendError(
        reply,
        400,
        'TARGET_NOT_ALLOWED',
        'Only a team automation names a repository to act on; a repository’s acts on its own'
      );
      return false;
    }
    const reachable = await fastify.prisma.connection.findFirst({
      select: { id: true },
      where: {
        id: targetConnectionId,
        OR: [{ teamId: access.team.id }, { shares: { some: { teamId: access.team.id } } }],
        type: 'git_repo',
      },
    });
    if (!reachable) {
      await sendError(
        reply,
        400,
        'TARGET_REPOSITORY_NOT_REACHABLE',
        'targetConnectionId must name a git repository the team owns or that is shared with it'
      );
      return false;
    }
    const repo = await findLaunchRepo(fastify.prisma, targetConnectionId, requireUser(request).sub);
    if (!repo) {
      await sendError(reply, 409, 'REPO_INACTIVE', 'The repository is not active');
      return false;
    }
    return repo;
  }

  /** The automation and its owner's access (repository or team), or a reply already sent. */
  async function loadAutomation(request: FastifyRequest, reply: FastifyReply, id: string) {
    const user = requireUser(request);
    const row = await fastify.prisma.automation.findUnique({
      select: automationSelect,
      where: { id },
    });
    const access = row
      ? await automationOwnerAccess(fastify.prisma, row, user, request.repoAccessGate)
      : null;
    if (!row || !access) {
      await sendError(reply, 404, 'AUTOMATION_NOT_FOUND', 'Automation not found');
      return null;
    }
    return { access, row, user };
  }

  /** The caller's access to the owner a query names, or a 404 already sent. */
  async function loadOwner(
    request: FastifyRequest,
    reply: FastifyReply,
    owner: { connectionId?: string; teamId?: string }
  ): Promise<AutomationOwnerAccess | null> {
    const access = await automationOwnerAccess(
      fastify.prisma,
      { connectionId: owner.connectionId ?? null, teamId: owner.teamId ?? null },
      requireUser(request),
      request.repoAccessGate
    );
    if (!access) {
      await (owner.connectionId !== undefined
        ? sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found')
        : sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found'));
    }
    return access;
  }

  /** Whether the owner can start runs now: an active repository, or an active team. */
  async function ownerActive(reply: FastifyReply, access: AutomationOwnerAccess) {
    if (access.kind === 'repository' && !access.repo.isActive) {
      await sendError(reply, 409, 'REPO_INACTIVE', 'The repository is not active');
      return false;
    }
    if (access.kind === 'team' && !access.team.isActive) {
      await sendError(reply, 409, 'TEAM_INACTIVE', 'The team is not active');
      return false;
    }
    return true;
  }

  // GET /api/v1/automations — every automation of the kinds this route owns that the caller
  // may see, normalised for one list: event automations on reachable repositories and on teams
  // they belong to, template webhook URLs on templates they can read, and (ADMIN only) the
  // tracker transition hook.
  // Schedules keep their own list route, permissions and live state; the dashboard merges them.
  app.get('/', { onRequest: signedIn }, async (request) => {
    const user = requireUser(request);
    const admin = user.role === 'ADMIN';

    // A repository automation through the repository the caller can reach; a team's (one with
    // no repository) through membership of its team. An admin sees all.
    const memberships = { select: { role: true }, where: { userId: user.sub } } as const;
    const automations = await runUnscoped(
      'an admin sees every automation; everyone else only those of reachable repositories and their own teams',
      ['Automation'],
      () =>
        fastify.prisma.automation.findMany({
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            ...automationSelect,
            connection: {
              select: {
                id: true,
                organizationName: true,
                repoName: true,
                team: { select: { id: true, memberships, name: true } },
              },
            },
            team: { select: { id: true, memberships, name: true } },
          },
          where: admin
            ? {}
            : {
                OR: [
                  { connection: reachableConnections(user, request.repoAccessGate) },
                  {
                    connectionId: null,
                    team: { memberships: { some: { userId: user.sub } } },
                  },
                ],
              },
        })
    );
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
    const events = automations.flatMap((a) => {
      const source = eventSource(a.source);
      const filters = source ? parseFilters(source, a.filters) : null;
      const { connection, team: ownTeam, ...rest } = a;
      // The team that manages it: the repository's owning team, or the automation's own.
      const team = connection?.team ?? ownTeam;
      if (!team) {
        return [];
      }
      const role = team.memberships[0]?.role;
      const automation = { ...rest, team: ownTeam ? { id: ownTeam.id, name: ownTeam.name } : null };
      const last = lastFires.get(a.id);
      return {
        automation,
        canManage: admin || role === 'LEAD' || role === 'ADMIN',
        enabled: a.enabled,
        id: a.id,
        kind: 'event' as const,
        lastActivity: last ? { at: last.createdAt, outcome: last.outcome } : null,
        name: a.name,
        repository: connection
          ? {
              id: connection.id,
              organizationName: connection.organizationName,
              repoName: connection.repoName,
            }
          : null,
        source: a.source,
        team: { id: team.id, name: team.name },
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
            team: { select: { id: true, name: true, orgId: true } },
            teamId: true,
            webhookRequireSignature: true,
            // Set exactly when a signing secret is; the secret itself is never read here.
            webhookSigningSecretKeyVersion: true,
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
    // Whether policy forces signing, once per team (a global template has none).
    const policyByTeam = new Map<string | null, Promise<boolean>>();
    const policyFor = (t: (typeof templates)[number]) => {
      let pending = policyByTeam.get(t.teamId);
      if (!pending) {
        pending = signatureRequiredByPolicy({ orgId: t.team?.orgId ?? null, teamId: t.teamId });
        policyByTeam.set(t.teamId, pending);
      }
      return pending;
    };
    const signaturePolicy = new Map(
      await Promise.all(templates.map(async (t) => [t.id, await policyFor(t)] as const))
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
        signatureRequired: t.webhookRequireSignature || signaturePolicy.get(t.id) === true,
        signed: t.webhookSigningSecretKeyVersion !== null,
        team: t.team ? { id: t.team.id, name: t.team.name } : null,
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

  // GET /api/v1/automations/events?connectionId= | ?teamId= — a repository's event
  // automations, or a team's (those with no repository).
  app.get(
    '/events',
    { onRequest: signedIn, schema: { querystring: ListQuery } },
    async (request, reply) => {
      const access = await loadOwner(request, reply, request.query);
      if (!access) {
        return;
      }
      const automations =
        access.kind === 'repository'
          ? await runUnscoped(
              'one repository the caller was just checked against',
              ['Automation'],
              () =>
                fastify.prisma.automation.findMany({
                  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                  select: automationSelect,
                  where: { connectionId: access.repo.id },
                })
            )
          : await fastify.prisma.automation.findMany({
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: automationSelect,
              where: { connectionId: null, teamId: access.team.id },
            });
      return { data: { automations, canManage: access.canManage } };
    }
  );

  // GET /api/v1/automations/events/templates?connectionId=|teamId=&source= — what an
  // automation of that source on that repository (or team) may start, with the options each
  // declares. Managers only: the owning team's own templates are its business.
  app.get(
    '/events/templates',
    { onRequest: signedIn, schema: { querystring: TemplatesQuery } },
    async (request, reply) => {
      const access = await loadOwner(request, reply, request.query);
      if (!access) {
        return;
      }
      if (!access.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', manageForbidden(access));
      }
      const source = eventSource(request.query.source);
      if (!source) {
        return sendError(reply, 400, 'UNKNOWN_SOURCE', 'Unknown event source');
      }
      const mismatch = targetMismatch(source, request.query);
      if (mismatch) {
        return sendError(reply, 400, 'SOURCE_TARGET_MISMATCH', mismatch);
      }
      const teamId = ownerTeam(access).id;
      const rows = await fastify.prisma.workflowTemplate.findMany({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { description: true, id: true, inputSchema: true, name: true },
        where: {
          AND: [
            {
              activeVersion: { not: null },
              OR: [{ teamId: null }, { teamId }],
              status: 'ACTIVE',
            },
            EXCLUDE_SYSTEM_TEMPLATES,
          ],
        },
      });
      const fallback = await resolveAutomationTemplate(fastify.prisma, source, null, teamId);
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
      const access = await loadOwner(request, reply, body);
      if (!access) {
        return;
      }
      if (!access.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', manageForbidden(access));
      }
      if (!(await ownerActive(reply, access))) {
        return;
      }
      const source = eventSource(body.source);
      if (!source) {
        return sendError(reply, 400, 'UNKNOWN_SOURCE', 'Unknown event source');
      }
      // Which owners a source's automations may have is the source's: none targets a team
      // today, so a team automation is refused for every shipped source.
      const mismatch = targetMismatch(source, body);
      if (mismatch) {
        return sendError(reply, 400, 'SOURCE_TARGET_MISMATCH', mismatch);
      }
      const target = await targetRepository(request, reply, access, body.targetConnectionId);
      if (target === false) {
        return;
      }
      if (body.enabled && !(await mayLaunch(request, reply, user, access, target))) {
        return;
      }
      const problem = await saveProblem(source, body, access);
      if (problem) {
        return sendError(reply, 400, problem.code, problem.message);
      }
      const created = await fastify.prisma.automation.create({
        data: {
          ...(access.kind === 'repository'
            ? { connectionId: access.repo.id }
            : { teamId: access.team.id }),
          cooldownMinutes: body.cooldownMinutes,
          createdById: user.sub,
          enabled: body.enabled,
          // Stored as the source parsed it (deduplicated, trimmed).
          filters: parseFilters(source, body.filters) as Prisma.InputJsonObject,
          inputs: body.inputs as Prisma.InputJsonObject,
          maxRunsPerDay: body.maxRunsPerDay,
          name: body.name,
          source: source.key,
          targetConnectionId: target ? target.id : null,
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
        return sendError(reply, 403, 'FORBIDDEN', manageForbidden(access));
      }
      const source = eventSource(existing.source);
      if (!source) {
        return sendError(reply, 409, 'UNKNOWN_SOURCE', 'The automation names an unknown source');
      }
      const body = request.body;
      const targetConnectionId =
        body.targetConnectionId === undefined
          ? (existing.targetConnectionId ?? null)
          : body.targetConnectionId;
      // A repository kept as it was on an automation that ends up off is not checked again: an
      // unreachable one must not stop the automation being switched off.
      const keepsTargetWhileOff =
        body.targetConnectionId === undefined && (body.enabled ?? existing.enabled) === false;
      const target = keepsTargetWhileOff
        ? null
        : await targetRepository(request, reply, access, targetConnectionId);
      if (target === false) {
        return;
      }
      // An automation that is off after the change cannot start runs, whatever else changed,
      // so editing a disabled one is not a launch decision. Anything that leaves it on is.
      if ((body.enabled ?? existing.enabled) !== false) {
        if (!(await ownerActive(reply, access))) {
          return;
        }
        if (!(await mayLaunch(request, reply, user, access, target))) {
          return;
        }
      }
      // Template, options, filters and the repository are checked together, as they will run.
      if (
        body.templateId !== undefined ||
        body.inputs !== undefined ||
        body.filters !== undefined ||
        body.targetConnectionId !== undefined
      ) {
        const problem = await saveProblem(
          source,
          {
            filters: body.filters ?? existing.filters,
            inputs: body.inputs ?? existing.inputs,
            targetConnectionId,
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

  // DELETE /api/v1/automations/events/:id — its decisions stay in its owner's ledger, which
  // the limits keep reading.
  app.delete(
    '/events/:id',
    { onRequest: signedIn, schema: { params: IdParams } },
    async (request, reply) => {
      const loaded = await loadAutomation(request, reply, request.params.id);
      if (!loaded) {
        return;
      }
      if (!loaded.access.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', manageForbidden(loaded.access));
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
        return sendError(reply, 403, 'FORBIDDEN', manageForbidden(access));
      }
      const fire = await fastify.prisma.automationFire.findFirst({
        select: { facts: true, id: true, outcome: true, ownerKey: true, retriedAt: true },
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
      // Defence in depth: a decision is taken again only on the owner it was recorded for — a
      // repository's on a repository key, and a team's on its own team's key. Inbound events name
      // their owner from the occurrence (the endpoint) and are checked below, against an endpoint
      // that must belong to the automation's team. Any other source that names its owner has no
      // such check here, so it is refused rather than let through.
      const ownerMatches =
        source.key === INBOUND_EVENT ||
        (source.ownerKey === undefined &&
          (access.kind === 'repository'
            ? isRepositoryOwnerKey(fire.ownerKey)
            : fire.ownerKey === teamOwnerKey(access.team.id)));
      if (!ownerMatches) {
        return sendError(
          reply,
          409,
          'NOT_RETRYABLE',
          'The decision was recorded for another owner than the automation’s'
        );
      }
      if (source.key === INBOUND_EVENT) {
        // The decision's owner must be an endpoint of the automation's team, still on, and the
        // one the recorded event names: a row whose owner key was written for another endpoint
        // (or another team's) is not taken again here.
        const owner = parseOwnerKey(fire.ownerKey);
        const endpointId =
          owner && owner.kind === ENDPOINT_OWNER_KIND && 'id' in owner ? owner.id : null;
        const recorded = (facts.data as { endpointId: string }).endpointId;
        const endpoint =
          access.kind === 'team' && endpointId !== null && endpointId === recorded
            ? await fastify.prisma.eventEndpoint.findFirst({
                select: { enabled: true },
                where: { id: endpointId, teamId: access.team.id },
              })
            : null;
        if (!endpoint?.enabled) {
          return sendError(
            reply,
            409,
            'NOT_RETRYABLE',
            'The event endpoint is gone, disabled, or not the team’s'
          );
        }
      }
      if (!automationMatches(source, automation, facts.data)) {
        return sendError(
          reply,
          409,
          'NOT_RETRYABLE',
          'The automation is off, or its filters no longer select this occurrence'
        );
      }
      // A repository automation decides on its repository row; a team's on its team, with no
      // repository.
      let owner: { connection: EngineConnection | null; team: EngineTeam };
      let targetUnavailable: string | undefined;
      let target: TargetRepo | null = null;
      if (access.kind === 'repository') {
        const connection = await fastify.prisma.connection.findFirst({
          include: connectionInclude,
          where: { id: access.repo.id, isActive: true, type: 'git_repo' },
        });
        if (!connection || isInstallationRetired(connection)) {
          return sendError(reply, 409, 'REPO_INACTIVE', 'The repository is not active');
        }
        owner = { connection, team: connection.team };
      } else {
        if (!(await ownerActive(reply, access))) {
          return;
        }
        const { id, organization, orgId } = access.team;
        // A team automation that acts on a repository decides on it, if it is still the team's.
        const connection = automation.targetConnectionId
          ? await loadTargetConnection(fastify.prisma, automation.targetConnectionId, id)
          : null;
        if (automation.targetConnectionId && !connection) {
          targetUnavailable = TARGET_UNAVAILABLE;
        }
        if (connection) {
          target = await findLaunchRepo(fastify.prisma, connection.id, user.sub);
        }
        owner = { connection, team: { id, organization, orgId } };
      }
      if (!(await mayLaunch(request, reply, user, access, target))) {
        return;
      }
      let result: Awaited<ReturnType<typeof decideAndStart>>;
      try {
        result = await decideAndStart(fastify, source, {
          ...owner,
          automation,
          facts: facts.data,
          now: new Date(),
          ownerKey: fire.ownerKey,
          retry: { fireId: fire.id, kind: 'manual' },
          startRetryDelayMs: 1_000,
          ...(targetUnavailable ? { targetUnavailable } : {}),
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
