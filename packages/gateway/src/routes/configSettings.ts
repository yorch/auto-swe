import { SETTING_SCOPE_ORDER } from '@auto-swe/shared/config';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  canReadScope,
  clearSetting,
  listSettings,
  type ScopeSelector,
  setSetting,
} from '../lib/configSettingsService.js';
import { writeSystemConfigAudit } from '../lib/systemConfigService.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * The config registry's HTTP surface.
 *
 * Deliberately NOT behind a blanket ADMIN hook, unlike every other config route
 * file: per-setting authorisation is the point. A route here authenticates the
 * caller and then asks the registry whether *this* actor may write *this* key
 * at *this* scope — which is what lets a team lead own their team's policy
 * without an admin in the loop.
 */

/// Registry writes share one audit entity id: the rows are keyed by setting
/// name rather than by a UUID, and ConfigAuditLog.entityId is a UUID column.
/// The key and scope live in the payload.
const SETTING_AUDIT_ENTITY_ID = '00000000-0000-0000-0001-000000000013';

const ScopeQuery = z.object({
  channelId: z.uuid().optional(),
  orgId: z.uuid().optional(),
  scope: z.enum(SETTING_SCOPE_ORDER).default('GLOBAL'),
  teamId: z.uuid().optional(),
  workflowTemplateId: z.uuid().optional(),
});

const GrantBody = z.object({
  keyPattern: z.string().min(1).max(120),
  orgId: z.uuid().optional(),
  role: z.enum(['ADMIN', 'LEAD', 'ENGINEER']).optional(),
  scope: z.enum(['GLOBAL', 'ORGANIZATION', 'TEAM']),
  teamId: z.uuid().optional(),
  userId: z.uuid().optional(),
});

function selectorFrom(query: z.infer<typeof ScopeQuery>): ScopeSelector {
  return {
    channelId: query.channelId,
    orgId: query.orgId,
    scope: query.scope,
    teamId: query.teamId,
    workflowTemplateId: query.workflowTemplateId,
  };
}

/// Maps an authorisation code onto a status. A denial that names a scope or key
/// the caller got wrong is a 400; one that says they lack authority is a 403.
function denialStatus(code: string): 400 | 403 {
  return code === 'UNKNOWN_SETTING' || code === 'SCOPE_NOT_ALLOWED' ? 400 : 403;
}

export const configSettingsRoutes: FastifyPluginAsync = async (
  fastify: FastifyInstance
): Promise<void> => {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // Authentication only. Authorisation is per-setting, below.
  f.addHook('onRequest', requireAuth());

  /// Every setting, its effective value for the requested scope, and where that
  /// value came from. This is the effective-config view — the diagnostic for
  /// "why is this run behaving that way", which had no answer before.
  f.get(
    '/config/settings',
    { schema: { querystring: ScopeQuery, response: { 200: z.any(), 403: z.any() } } },
    async (req, reply) => {
      const query = req.query;
      const actor = requireUser(req);
      const selector = selectorFrom(query);

      // A scoped read exposes another tenant's resolved configuration, so it
      // needs the same membership check a scoped write gets — grants only
      // authorise writes, and there is nothing else guarding the ids in the
      // query string.
      if (!(await canReadScope(fastify.prisma, { id: actor.sub, role: actor.role }, selector))) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You are not a member of the team or organization for this scope.',
          },
        });
      }

      const settings = await listSettings(
        fastify.prisma,
        { id: actor.sub, role: actor.role },
        {
          channelId: query.channelId,
          orgId: query.orgId,
          teamId: query.teamId,
          workflowTemplateId: query.workflowTemplateId,
        },
        selector
      );
      return reply.send({ data: settings });
    }
  );

  f.put(
    '/config/settings/:key',
    {
      schema: {
        body: z.object({ value: z.unknown() }),
        params: z.object({ key: z.string().min(1).max(120) }),
        querystring: ScopeQuery,
        response: { 200: z.any(), 400: z.any(), 403: z.any() },
      },
    },
    async (req, reply) => {
      const actor = requireUser(req);
      const selector = selectorFrom(req.query);
      const result = await setSetting(
        fastify.prisma,
        { id: actor.sub, role: actor.role },
        req.params.key,
        selector,
        req.body.value
      );

      if ('validationError' in result) {
        return reply.status(400).send({
          error: { code: 'SETTING_INVALID', message: result.validationError },
        });
      }
      if (result.denial) {
        return reply.status(denialStatus(result.denial.code)).send({
          error: { code: result.denial.code, message: result.denial.message },
        });
      }

      await writeSystemConfigAudit(fastify.prisma, fastify.log, {
        action: result.before === undefined ? 'CREATE' : 'UPDATE',
        actorId: actor.sub,
        afterJson: {
          changedFields: [req.params.key],
          key: req.params.key,
          scope: selector.scope,
          value: result.after,
        },
        beforeJson: result.before === undefined ? null : { value: result.before },
        entityId: SETTING_AUDIT_ENTITY_ID,
        entityType: 'ConfigSetting',
      });

      return reply.send({
        data: { key: req.params.key, scope: selector.scope, value: result.after },
      });
    }
  );

  /// Removes the override at one scope so the key falls back to the next scope
  /// down — the only way to "unset" a value, since a definition always has a
  /// default and there is no null to store.
  f.delete(
    '/config/settings/:key',
    {
      schema: {
        params: z.object({ key: z.string().min(1).max(120) }),
        querystring: ScopeQuery,
        response: { 200: z.any(), 400: z.any(), 403: z.any() },
      },
    },
    async (req, reply) => {
      const actor = requireUser(req);
      const selector = selectorFrom(req.query);
      const result = await clearSetting(
        fastify.prisma,
        { id: actor.sub, role: actor.role },
        req.params.key,
        selector
      );
      if (result.denial) {
        return reply.status(denialStatus(result.denial.code)).send({
          error: { code: result.denial.code, message: result.denial.message },
        });
      }
      if (result.before !== undefined) {
        await writeSystemConfigAudit(fastify.prisma, fastify.log, {
          action: 'UPDATE',
          actorId: actor.sub,
          afterJson: {
            changedFields: [req.params.key],
            cleared: true,
            key: req.params.key,
            scope: selector.scope,
          },
          beforeJson: { value: result.before },
          entityId: SETTING_AUDIT_ENTITY_ID,
          entityType: 'ConfigSetting',
        });
      }
      return reply.send({ data: { cleared: result.before !== undefined } });
    }
  );

  // ── Grants ────────────────────────────────────────────────────────────────
  // Managing who may configure what stays ADMIN-only. Letting a grant holder
  // mint further grants would make the model self-widening, which defeats the
  // point of writing authority down.

  f.get(
    '/config/grants',
    { preHandler: requireAuth({ requiredRole: 'ADMIN' }), schema: { response: { 200: z.any() } } },
    async (_req, reply) => {
      const grants = await runUnscoped(
        'the admin grant listing is deployment-wide by definition',
        ['ConfigPermission'],
        () =>
          fastify.prisma.configPermission.findMany({
            include: {
              organization: { select: { name: true } },
              team: { select: { name: true } },
              user: { select: { email: true } },
            },
            orderBy: { createdAt: 'desc' },
          })
      );
      return reply.send({ data: grants });
    }
  );

  f.post(
    '/config/grants',
    {
      preHandler: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: GrantBody, response: { 200: z.any(), 400: z.any() } },
    },
    async (req, reply) => {
      const body = req.body;
      if ((body.userId ? 1 : 0) + (body.role ? 1 : 0) !== 1) {
        return reply.status(400).send({
          error: {
            code: 'GRANT_INVALID',
            message: 'A grant names exactly one grantee: either userId or role.',
          },
        });
      }
      if (body.scope === 'TEAM' && !body.teamId) {
        return reply
          .status(400)
          .send({ error: { code: 'GRANT_INVALID', message: 'A TEAM grant needs a teamId.' } });
      }
      if (body.scope === 'ORGANIZATION' && !body.orgId) {
        return reply.status(400).send({
          error: { code: 'GRANT_INVALID', message: 'An ORGANIZATION grant needs an orgId.' },
        });
      }

      const actor = requireUser(req);
      const grant = await fastify.prisma.configPermission.create({
        data: {
          createdById: actor.sub,
          keyPattern: body.keyPattern,
          orgId: body.scope === 'ORGANIZATION' ? body.orgId : null,
          role: body.role ?? null,
          scope: body.scope,
          teamId: body.scope === 'TEAM' ? body.teamId : null,
          userId: body.userId ?? null,
        },
      });
      await writeSystemConfigAudit(fastify.prisma, fastify.log, {
        action: 'CREATE',
        actorId: actor.sub,
        afterJson: { ...body, changedFields: [body.keyPattern] },
        beforeJson: null,
        entityId: grant.id,
        entityType: 'ConfigPermission',
      });
      return reply.send({ data: grant });
    }
  );

  f.delete(
    '/config/grants/:id',
    {
      preHandler: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: z.object({ id: z.uuid() }), response: { 200: z.any(), 404: z.any() } },
    },
    async (req, reply) => {
      const existing = await fastify.prisma.configPermission.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Grant not found.' } });
      }
      await fastify.prisma.configPermission.delete({ where: { id: req.params.id } });
      const actor = requireUser(req);
      await writeSystemConfigAudit(fastify.prisma, fastify.log, {
        action: 'UPDATE',
        actorId: actor.sub,
        afterJson: { changedFields: [existing.keyPattern], revoked: true },
        // The full grant, including which team or org the authority covered —
        // without those ids the entry cannot answer "who could configure team
        // 42 before today", which is the question a revocation audit is for.
        beforeJson: {
          keyPattern: existing.keyPattern,
          orgId: existing.orgId,
          role: existing.role,
          scope: existing.scope,
          teamId: existing.teamId,
          userId: existing.userId,
        },
        entityId: existing.id,
        entityType: 'ConfigPermission',
      });
      return reply.send({ data: { revoked: true } });
    }
  );
};
