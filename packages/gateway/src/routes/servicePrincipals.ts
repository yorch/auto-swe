/**
 * Managing a team's service principals (docs/service-principals.md) and their tokens.
 *
 *   GET    /api/v1/teams/:teamId/service-principals
 *   POST   /api/v1/teams/:teamId/service-principals
 *   GET    /api/v1/teams/:teamId/service-principals/:id
 *   PATCH  /api/v1/teams/:teamId/service-principals/:id
 *   DELETE /api/v1/teams/:teamId/service-principals/:id
 *   GET    /api/v1/teams/:teamId/service-principals/:id/tokens
 *   POST   /api/v1/teams/:teamId/service-principals/:id/tokens          (plaintext returned once)
 *   DELETE /api/v1/teams/:teamId/service-principals/:id/tokens/:tokenId (revoke)
 *
 * Every route needs ADMIN, or LEAD on the team — the bar the team's members and settings have.
 * Putting a connection on a principal's allowlist is a launch decision taken by the lead making the
 * change, as saving an event automation is: the repository must be one the principal's team owns
 * or has shared with it, and `authorizeLaunch` (the access gate on the lead's own login, org
 * membership, the org's monthly cap) must admit the lead. Taking one off is always allowed. Every
 * change is audited (`ServicePrincipal`, `ServiceToken`); a token's plaintext and hash never are.
 */
import type { Prisma } from '@auto-swe/shared';
import { isSystemManagedTemplate } from '@auto-swe/shared/lib/channelTask';
import { isRepoTeam, repoMembersSelect } from '@auto-swe/shared/lib/repoMembership';
import {
  SERVICE_TOKEN_MAX_DAYS,
  SERVICE_TOKEN_MAX_LIVE,
  SERVICE_TOKEN_SCOPES,
} from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { authorizeLaunch, sendLaunchRefusal } from '../lib/launchAuthorization.js';
import { safePatAuditFields } from '../lib/patAuditFields.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';
import { generateToken, tokenPrefix } from './tokens.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Bounds on what one principal's allowlists may hold. */
const MAX_ALLOWLIST = 100;

const TeamParams = z.object({ teamId: z.string().uuid() });
const PrincipalParams = TeamParams.extend({ id: z.string().uuid() });
const TokenParams = PrincipalParams.extend({ tokenId: z.string().uuid() });

const IdList = z
  .array(z.string().uuid())
  .max(MAX_ALLOWLIST)
  .transform((ids) => [...new Set(ids)]);

const Fields = {
  connectionIds: IdList,
  description: z.string().trim().max(500).nullable(),
  maxInFlight: z.number().int().min(1).max(100),
  maxRunsPerDay: z.number().int().min(1).max(10_000),
  name: z.string().trim().min(1).max(100),
  templateIds: IdList,
};

const CreateBody = z.object({
  ...Fields,
  connectionIds: Fields.connectionIds.default([]),
  description: Fields.description.optional(),
  maxInFlight: Fields.maxInFlight.default(5),
  maxRunsPerDay: Fields.maxRunsPerDay.default(50),
  templateIds: Fields.templateIds.default([]),
});

const UpdateBody = z.object({ ...Fields, disabled: z.boolean() }).partial();

const CreateTokenBody = z.object({
  /** Every service token expires; at most a year out. */
  expiresInDays: z.number().int().min(1).max(SERVICE_TOKEN_MAX_DAYS),
  name: z.string().trim().min(1).max(120),
  scopes: z
    .array(z.enum(SERVICE_TOKEN_SCOPES))
    .min(1)
    .transform((s) => [...new Set(s)]),
});

const principalSelect = {
  connectionIds: true,
  createdAt: true,
  createdBy: { select: { email: true, id: true } },
  description: true,
  disabledAt: true,
  id: true,
  maxInFlight: true,
  maxRunsPerDay: true,
  name: true,
  teamId: true,
  templateIds: true,
  updatedAt: true,
} as const;

const tokenSelect = {
  createdAt: true,
  expiresAt: true,
  id: true,
  lastUsedAt: true,
  name: true,
  prefix: true,
  revokedAt: true,
  scopes: true,
} as const;

type PrincipalRow = Prisma.ServicePrincipalGetPayload<{ select: typeof principalSelect }>;

/** Auditable subset of a principal row (it holds no secret). */
function principalAuditFields(row: Omit<PrincipalRow, 'createdBy' | 'createdAt' | 'updatedAt'>) {
  return {
    connectionIds: row.connectionIds,
    description: row.description,
    disabledAt: row.disabledAt,
    id: row.id,
    maxInFlight: row.maxInFlight,
    maxRunsPerDay: row.maxRunsPerDay,
    name: row.name,
    teamId: row.teamId,
    templateIds: row.templateIds,
  };
}

/** Tokens that still authenticate: neither revoked nor expired. */
function liveTokenWhere(now: Date): Prisma.ApiTokenWhereInput {
  return { expiresAt: { gt: now }, revokedAt: null };
}

export const servicePrincipalRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const lead = requireAuth({
    requiredRole: 'LEAD',
    requiredTeamRole: 'LEAD',
    teamIdParam: 'teamId',
  });

  /** The team, or null after replying 404. A platform ADMIN passes the role check for any id. */
  async function findTeam(reply: FastifyReply, teamId: string) {
    const team = await fastify.prisma.team.findUnique({
      select: { id: true },
      where: { id: teamId },
    });
    if (!team) {
      sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      return null;
    }
    return team;
  }

  async function findPrincipal(reply: FastifyReply, teamId: string, id: string) {
    const row = await fastify.prisma.servicePrincipal.findFirst({
      select: principalSelect,
      where: { id, teamId },
    });
    if (!row) {
      sendError(reply, 404, 'SERVICE_PRINCIPAL_NOT_FOUND', 'Service principal not found');
      return null;
    }
    return row;
  }

  /**
   * Decide every addition to a principal's allowlists, sending the refusal and returning false on
   * the first that fails. Removals need no decision. A connection must be active and owned by or
   * shared with the principal's team, and putting it on the list is a launch decision for the
   * acting lead (the platform run identity: the principal's runs use the platform credential, so
   * the gate judges the lead's own login, as for an event automation). A template must be global
   * or the team's own, and one a person may run by hand.
   */
  async function decideGrants(
    request: FastifyRequest,
    reply: FastifyReply,
    user: JwtPayload,
    teamId: string,
    before: { connectionIds: string[]; templateIds: string[] },
    after: { connectionIds?: string[]; templateIds?: string[] }
  ): Promise<boolean> {
    const addedConnections = (after.connectionIds ?? []).filter(
      (id) => !before.connectionIds.includes(id)
    );
    for (const connectionId of addedConnections) {
      const connection = await fastify.prisma.connection.findUnique({
        select: {
          githubApiUrl: true,
          githubUrl: true,
          id: true,
          installation: { select: { host: true, installationId: true, isActive: true } },
          isActive: true,
          organizationName: true,
          repoName: true,
          shares: {
            select: {
              ...repoMembersSelect({ userId: true }, { userId: user.sub }).shares.select,
              teamId: true,
            },
          },
          team: {
            select: {
              memberships: { select: { userId: true }, where: { userId: user.sub } },
              organization: { select: { monthlyBudgetUsdCents: true } },
              orgId: true,
            },
          },
          teamId: true,
          type: true,
        },
        where: { id: connectionId },
      });
      if (!connection?.isActive || !isRepoTeam(connection, teamId)) {
        sendError(
          reply,
          400,
          'CONNECTION_NOT_GRANTABLE',
          `Connection ${connectionId} is not an active connection this team owns or has shared with it`
        );
        return false;
      }
      const decision = await authorizeLaunch(fastify.prisma, user, {
        gate: request.repoAccessGate,
        log: request.log,
        repos: [connection],
        runIdentity: 'platform',
      });
      if (!decision.ok) {
        sendLaunchRefusal(reply, decision.refusal);
        return false;
      }
    }

    const addedTemplates = (after.templateIds ?? []).filter(
      (id) => !before.templateIds.includes(id)
    );
    for (const templateId of addedTemplates) {
      const tpl = await fastify.prisma.workflowTemplate.findUnique({
        select: { id: true, name: true, origin: true, status: true, teamId: true },
        where: { id: templateId },
      });
      const grantable =
        tpl &&
        tpl.status !== 'ARCHIVED' &&
        (tpl.teamId === null || tpl.teamId === teamId) &&
        // Platform-started templates (the agent run, the channel assistant) are not run by hand.
        !tpl.origin?.startsWith('system:') &&
        !isSystemManagedTemplate({ name: tpl.name, team: tpl.teamId ? {} : null });
      if (!grantable) {
        sendError(
          reply,
          400,
          'TEMPLATE_NOT_GRANTABLE',
          `Template ${templateId} is not a global or team template this principal may run`
        );
        return false;
      }
    }
    return true;
  }

  // ── List ──
  app.get(
    '/:teamId/service-principals',
    { onRequest: lead, schema: { params: TeamParams } },
    async (request, reply) => {
      const { teamId } = request.params;
      if (!(await findTeam(reply, teamId))) {
        return;
      }
      const now = new Date();
      const rows = await fastify.prisma.servicePrincipal.findMany({
        orderBy: { name: 'asc' },
        select: {
          ...principalSelect,
          _count: { select: { tokens: { where: liveTokenWhere(now) } } },
        },
        where: { teamId },
      });
      return {
        data: rows.map(({ _count, ...row }) => ({ ...row, liveTokenCount: _count.tokens })),
      };
    }
  );

  // ── Create ──
  app.post(
    '/:teamId/service-principals',
    { onRequest: lead, schema: { body: CreateBody, params: TeamParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const { teamId } = request.params;
      if (!(await findTeam(reply, teamId))) {
        return;
      }
      const body = request.body;
      const empty = { connectionIds: [], templateIds: [] };
      if (!(await decideGrants(request, reply, user, teamId, empty, body))) {
        return;
      }
      let created: PrincipalRow;
      try {
        created = await fastify.prisma.servicePrincipal.create({
          data: {
            connectionIds: body.connectionIds,
            createdById: user.sub,
            description: body.description ?? null,
            maxInFlight: body.maxInFlight,
            maxRunsPerDay: body.maxRunsPerDay,
            name: body.name,
            teamId,
            templateIds: body.templateIds,
          },
          select: principalSelect,
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendError(
            reply,
            409,
            'SERVICE_PRINCIPAL_NAME_TAKEN',
            'This team already has a service principal with that name'
          );
        }
        throw err;
      }
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor: user,
        after: principalAuditFields(created),
        entityId: created.id,
        entityType: 'ServicePrincipal',
      });
      return reply.status(201).send({ data: { ...created, liveTokenCount: 0 } });
    }
  );

  // ── Get one ──
  app.get(
    '/:teamId/service-principals/:id',
    { onRequest: lead, schema: { params: PrincipalParams } },
    async (request, reply) => {
      const { id, teamId } = request.params;
      const row = await findPrincipal(reply, teamId, id);
      if (!row) {
        return;
      }
      const liveTokenCount = await fastify.prisma.apiToken.count({
        where: { servicePrincipalId: row.id, ...liveTokenWhere(new Date()) },
      });
      return { data: { ...row, liveTokenCount } };
    }
  );

  // ── Update (including disable / enable) ──
  app.patch(
    '/:teamId/service-principals/:id',
    { onRequest: lead, schema: { body: UpdateBody, params: PrincipalParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const { id, teamId } = request.params;
      const existing = await findPrincipal(reply, teamId, id);
      if (!existing) {
        return;
      }
      const body = request.body;
      if (!(await decideGrants(request, reply, user, teamId, existing, body))) {
        return;
      }
      const disabledAt =
        body.disabled === undefined
          ? undefined
          : body.disabled
            ? (existing.disabledAt ?? new Date())
            : null;
      let updated: PrincipalRow;
      try {
        updated = await fastify.prisma.servicePrincipal.update({
          data: {
            ...(body.connectionIds !== undefined ? { connectionIds: body.connectionIds } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(disabledAt !== undefined ? { disabledAt } : {}),
            ...(body.maxInFlight !== undefined ? { maxInFlight: body.maxInFlight } : {}),
            ...(body.maxRunsPerDay !== undefined ? { maxRunsPerDay: body.maxRunsPerDay } : {}),
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.templateIds !== undefined ? { templateIds: body.templateIds } : {}),
          },
          select: principalSelect,
          where: { id: existing.id },
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendError(
            reply,
            409,
            'SERVICE_PRINCIPAL_NAME_TAKEN',
            'This team already has a service principal with that name'
          );
        }
        throw err;
      }
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: principalAuditFields(updated),
        before: principalAuditFields(existing),
        entityId: updated.id,
        entityType: 'ServicePrincipal',
      });
      const liveTokenCount = await fastify.prisma.apiToken.count({
        where: { servicePrincipalId: updated.id, ...liveTokenWhere(new Date()) },
      });
      return { data: { ...updated, liveTokenCount } };
    }
  );

  // ── Delete (its tokens go with it; its runs keep running, unattributed) ──
  app.delete(
    '/:teamId/service-principals/:id',
    { onRequest: lead, schema: { params: PrincipalParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const { id, teamId } = request.params;
      const existing = await findPrincipal(reply, teamId, id);
      if (!existing) {
        return;
      }
      await fastify.prisma.servicePrincipal.delete({ where: { id: existing.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor: user,
        before: principalAuditFields(existing),
        entityId: existing.id,
        entityType: 'ServicePrincipal',
      });
      return reply.status(204).send();
    }
  );

  // ── Tokens: list ──
  app.get(
    '/:teamId/service-principals/:id/tokens',
    { onRequest: lead, schema: { params: PrincipalParams } },
    async (request, reply) => {
      const { id, teamId } = request.params;
      const principal = await findPrincipal(reply, teamId, id);
      if (!principal) {
        return;
      }
      const rows = await fastify.prisma.apiToken.findMany({
        orderBy: { createdAt: 'desc' },
        select: tokenSelect,
        where: { servicePrincipalId: principal.id },
      });
      return { data: rows };
    }
  );

  // ── Tokens: mint (plaintext returned exactly once) ──
  app.post(
    '/:teamId/service-principals/:id/tokens',
    { onRequest: lead, schema: { body: CreateTokenBody, params: PrincipalParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const { id, teamId } = request.params;
      const principal = await findPrincipal(reply, teamId, id);
      if (!principal) {
        return;
      }
      const { expiresInDays, name, scopes } = request.body;
      const plaintext = generateToken();
      const now = new Date();
      const outcome = await fastify.prisma.$transaction(async (tx) => {
        // CLAUDE.md §7 exception: serialize the live-token count with concurrent mints, so two
        // at once cannot both see room for one more.
        await tx.$queryRaw`SELECT id FROM service_principals WHERE id = ${principal.id}::uuid FOR UPDATE`;
        const live = await tx.apiToken.count({
          where: { servicePrincipalId: principal.id, ...liveTokenWhere(now) },
        });
        if (live >= SERVICE_TOKEN_MAX_LIVE) {
          return null;
        }
        const created = await tx.apiToken.create({
          data: {
            expiresAt: new Date(now.getTime() + expiresInDays * DAY_MS),
            name,
            prefix: tokenPrefix(plaintext),
            scopes,
            servicePrincipalId: principal.id,
            tokenHash: fastify.auth.hashToken(plaintext),
          },
          select: { ...tokenSelect, servicePrincipalId: true, userId: true },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: user,
          after: safePatAuditFields(created),
          client: tx,
          entityId: created.id,
          entityType: 'ServiceToken',
        });
        return created;
      });
      if (!outcome) {
        return sendError(
          reply,
          409,
          'SERVICE_TOKEN_LIMIT_REACHED',
          `A service principal holds at most ${SERVICE_TOKEN_MAX_LIVE} live tokens; revoke one first`
        );
      }
      // Plaintext appears in this response and NEVER again.
      return reply.status(201).send({
        data: {
          createdAt: outcome.createdAt,
          expiresAt: outcome.expiresAt,
          id: outcome.id,
          lastUsedAt: outcome.lastUsedAt,
          name: outcome.name,
          prefix: outcome.prefix,
          revokedAt: outcome.revokedAt,
          scopes: outcome.scopes,
          token: plaintext,
        },
      });
    }
  );

  // ── Tokens: revoke ──
  app.delete(
    '/:teamId/service-principals/:id/tokens/:tokenId',
    { onRequest: lead, schema: { params: TokenParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const { id, teamId, tokenId } = request.params;
      const principal = await findPrincipal(reply, teamId, id);
      if (!principal) {
        return;
      }
      const existing = await fastify.prisma.apiToken.findFirst({
        select: { ...tokenSelect, servicePrincipalId: true, userId: true },
        where: { id: tokenId, servicePrincipalId: principal.id },
      });
      if (!existing) {
        return sendError(reply, 404, 'TOKEN_NOT_FOUND', 'Token not found');
      }
      if (existing.revokedAt) {
        return { data: { id: existing.id, revokedAt: existing.revokedAt } };
      }
      const updated = await fastify.prisma.apiToken.update({
        data: { revokedAt: new Date() },
        select: { ...tokenSelect, servicePrincipalId: true, userId: true },
        where: { id: existing.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: safePatAuditFields(updated),
        before: safePatAuditFields(existing),
        entityId: updated.id,
        entityType: 'ServiceToken',
      });
      return { data: { id: updated.id, revokedAt: updated.revokedAt } };
    }
  );
};
