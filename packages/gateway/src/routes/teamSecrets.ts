/**
 * Team secrets: named, write-only values a team holds once and grants to repositories it owns.
 *
 * Managing them takes the shell-authoring role (a team ADMIN, or a platform ADMIN): the value
 * reaches setup steps as secret environment. Reads return the name, the last four characters and
 * the granted repository ids, never a value, and audit entries carry only names and ids.
 */
import { encryptSecret } from '@auto-swe/shared';
import {
  MAX_TEAM_SECRETS,
  MIN_REPO_SETUP_SECRET_CHARS,
  TeamSecretNameSchema,
} from '@auto-swe/shared/lib/repoSetup';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const TeamParamsSchema = z.object({ teamId: z.string().uuid() });
const SecretParamsSchema = TeamParamsSchema.extend({ name: TeamSecretNameSchema });

const MAX_GRANTS = 200;

const summarySelect = {
  grants: { select: { connectionId: true } },
  name: true,
  updatedAt: true,
  valueLastFour: true,
} as const;

function summary(row: {
  grants: { connectionId: string }[];
  name: string;
  updatedAt: Date;
  valueLastFour: string;
}) {
  return {
    grantedConnectionIds: row.grants.map((g) => g.connectionId).sort(),
    lastFour: row.valueLastFour,
    name: row.name,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const teamSecretRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  // Platform ADMINs pass the team check; any other caller must be an ADMIN of this team.
  const teamAdmin = () =>
    requireAuth({ requiredRole: 'ENGINEER', requiredTeamRole: 'ADMIN', teamIdParam: 'teamId' });

  app.get(
    '/:teamId/secrets',
    { onRequest: teamAdmin(), schema: { params: TeamParamsSchema } },
    async (request) => {
      const rows = await fastify.prisma.teamSecret.findMany({
        orderBy: { name: 'asc' },
        select: summarySelect,
        where: { teamId: request.params.teamId },
      });
      return { data: rows.map(summary) };
    }
  );

  app.put(
    '/:teamId/secrets/:name',
    {
      onRequest: teamAdmin(),
      schema: {
        body: z.object({
          value: z
            .string()
            .min(
              MIN_REPO_SETUP_SECRET_CHARS,
              `must be at least ${MIN_REPO_SETUP_SECRET_CHARS} characters`
            )
            .max(16_384),
        }),
        params: SecretParamsSchema,
      },
    },
    async (request, reply) => {
      const { name, teamId } = request.params;
      const user = requireUser(request);
      const team = await fastify.prisma.team.findUnique({
        select: { isActive: true },
        where: { id: teamId },
      });
      if (!team) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }
      if (!team.isActive) {
        return sendError(reply, 409, 'TEAM_INACTIVE', 'The team is not active');
      }
      const prior = await fastify.prisma.teamSecret.findUnique({
        select: { id: true },
        where: { teamId_name: { name, teamId } },
      });
      if (!prior) {
        const held = await fastify.prisma.teamSecret.count({ where: { teamId } });
        if (held >= MAX_TEAM_SECRETS) {
          return sendError(
            reply,
            409,
            'TEAM_SECRET_LIMIT',
            `A team holds at most ${MAX_TEAM_SECRETS} secrets`
          );
        }
      }
      const sealed = encryptSecret(request.body.value);
      const value = {
        valueAuthTag: sealed.authTag,
        valueCiphertext: sealed.ciphertext,
        valueKeyVersion: sealed.keyVersion,
        valueLastFour: sealed.lastFour,
        valueNonce: sealed.nonce,
      };
      const row = await fastify.prisma.teamSecret.upsert({
        create: { createdById: user.sub, name, teamId, ...value },
        select: summarySelect,
        update: value,
        where: { teamId_name: { name, teamId } },
      });
      await writeAuditLog(fastify, {
        action: prior ? 'UPDATE' : 'CREATE',
        actor: user,
        after: { teamSecret: name },
        entityId: teamId,
        entityType: 'TeamSecret',
      });
      return { data: summary(row) };
    }
  );

  app.delete(
    '/:teamId/secrets/:name',
    { onRequest: teamAdmin(), schema: { params: SecretParamsSchema } },
    async (request, reply) => {
      const { name, teamId } = request.params;
      const { count } = await fastify.prisma.teamSecret.deleteMany({ where: { name, teamId } });
      if (!count) {
        return sendError(reply, 404, 'NOT_FOUND', 'Team secret not found');
      }
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor: requireUser(request),
        before: { teamSecret: name },
        entityId: teamId,
        entityType: 'TeamSecret',
      });
      return reply.status(204).send();
    }
  );

  app.put(
    '/:teamId/secrets/:name/grants',
    {
      onRequest: teamAdmin(),
      schema: {
        body: z.object({ connectionIds: z.array(z.string().uuid()).max(MAX_GRANTS) }),
        params: SecretParamsSchema,
      },
    },
    async (request, reply) => {
      const { name, teamId } = request.params;
      const user = requireUser(request);
      const connectionIds = [...new Set(request.body.connectionIds)].sort();
      const secret = await fastify.prisma.teamSecret.findUnique({
        select: { grants: { select: { connectionId: true } }, id: true },
        where: { teamId_name: { name, teamId } },
      });
      if (!secret) {
        return sendError(reply, 404, 'NOT_FOUND', 'Team secret not found');
      }
      // Only repositories the team OWNS: one merely shared to it is another team's.
      if (connectionIds.length) {
        const owned = await fastify.prisma.connection.findMany({
          select: { id: true },
          where: { id: { in: connectionIds }, teamId, type: 'git_repo' },
        });
        if (owned.length !== connectionIds.length) {
          return sendError(
            reply,
            400,
            'GRANT_REPO_NOT_OWNED',
            'Secrets can be granted only to repositories this team owns'
          );
        }
      }
      const before = secret.grants.map((g) => g.connectionId).sort();
      const added = connectionIds.filter((id) => !before.includes(id));
      await fastify.prisma.$transaction(async (tx) => {
        await tx.teamSecretGrant.deleteMany({
          where: { connectionId: { notIn: connectionIds }, teamSecretId: secret.id },
        });
        if (added.length) {
          await tx.teamSecretGrant.createMany({
            data: added.map((connectionId) => ({
              connectionId,
              createdById: user.sub,
              teamSecretId: secret.id,
            })),
            skipDuplicates: true,
          });
        }
      });
      if (added.length) {
        await resolveSatisfiedBlockers(added, teamId);
      }
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: { grantedConnectionIds: connectionIds, teamSecret: name },
        before: { grantedConnectionIds: before, teamSecret: name },
        entityId: teamId,
        entityType: 'TeamSecret',
      });
      const row = await fastify.prisma.teamSecret.findUniqueOrThrow({
        select: summarySelect,
        where: { teamId_name: { name, teamId } },
      });
      return { data: summary(row) };
    }
  );

  /**
   * Close the open `missing_secret` blockers a new grant has just made moot. A blocker's subject
   * is the comma-joined list of every name the run found missing, so it is closed only when each
   * name on it is now supplied, by the repository's own secret or by a grant from its team.
   */
  async function resolveSatisfiedBlockers(connectionIds: string[], teamId: string) {
    const open = await fastify.prisma.repoSetupBlocker.findMany({
      select: { connectionId: true, id: true, subject: true },
      where: { connectionId: { in: connectionIds }, kind: 'missing_secret', resolvedAt: null },
    });
    if (!open.length) {
      return;
    }
    const wanted = (subject: string) =>
      subject
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
    const names = [...new Set(open.flatMap((b) => wanted(b.subject)))];
    const [own, granted] = await Promise.all([
      fastify.prisma.repoSetupSecret.findMany({
        select: { connectionId: true, name: true },
        where: { connectionId: { in: connectionIds }, name: { in: names } },
      }),
      fastify.prisma.teamSecretGrant.findMany({
        select: { connectionId: true, teamSecret: { select: { name: true } } },
        where: {
          connectionId: { in: connectionIds },
          teamSecret: { name: { in: names }, teamId },
        },
      }),
    ]);
    const have = new Set([
      ...own.map((r) => `${r.connectionId}\0${r.name}`),
      ...granted.map((r) => `${r.connectionId}\0${r.teamSecret.name}`),
    ]);
    const done = open
      .filter((b) => wanted(b.subject).every((n) => have.has(`${b.connectionId}\0${n}`)))
      .map((b) => b.id);
    if (done.length) {
      await fastify.prisma.repoSetupBlocker.updateMany({
        data: { resolvedAt: new Date() },
        where: { id: { in: done }, resolvedAt: null },
      });
    }
  }
};
