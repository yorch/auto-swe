/**
 * Team enablement of approved plugins (harness profiles).
 *
 * A platform ADMIN approves a plugin for the whole platform; a team ADMIN then enables it for their
 * team, and only an enabled plugin can be bound on that team's agent overrides. Role is the team
 * role alone (a platform ADMIN passes it): there is no platform LEAD floor on top.
 *
 *   GET    /api/v1/teams/:teamId/plugins         Approved, non-disabled plugins with an `enabled` flag (any team member)
 *   PUT    /api/v1/teams/:teamId/plugins/:name   Enable one (team ADMIN); idempotent
 *   DELETE /api/v1/teams/:teamId/plugins/:name   Disable one (team ADMIN); answers with the team's stranded agents
 *
 * Removing an enablement while agents are bound is allowed: their new runs fail closed with an
 * error naming the plugin, runs in flight keep their pinned snapshot, and the response lists the
 * agents that were stranded (`docs/harness-profiles.md`).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { boundAgentsForProfile } from '../lib/harnessProfileService.js';
import { sendError } from '../lib/httpErrors.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const TeamParams = z.object({ teamId: z.string().uuid() });
const PluginParams = TeamParams.extend({ name: z.string().min(1).max(64) });

export const pluginEnablementRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const teamMember = requireAuth({
    requiredRole: 'ENGINEER',
    requiredTeamRole: 'ENGINEER',
    teamIdParam: 'teamId',
  });
  const teamAdmin = requireAuth({
    requiredRole: 'ENGINEER',
    requiredTeamRole: 'ADMIN',
    teamIdParam: 'teamId',
  });

  app.get(
    '/:teamId/plugins',
    { onRequest: teamMember, schema: { params: TeamParams } },
    async (request) => {
      const { teamId } = request.params;
      const [profiles, enabled] = await Promise.all([
        fastify.prisma.harnessProfile.findMany({
          orderBy: { name: 'asc' },
          select: {
            description: true,
            hooksEnabled: true,
            id: true,
            latestVersion: true,
            name: true,
          },
          where: { status: 'OK' },
        }),
        fastify.prisma.pluginEnablement.findMany({
          select: { createdAt: true, profileId: true },
          where: { teamId },
        }),
      ]);
      const since = new Map(enabled.map((e) => [e.profileId, e.createdAt]));
      return {
        data: profiles.map((p) => ({
          description: p.description,
          enabled: since.has(p.id),
          enabledAt: since.get(p.id)?.toISOString() ?? null,
          hooksEnabled: p.hooksEnabled,
          latestVersion: p.latestVersion,
          name: p.name,
        })),
      };
    }
  );

  app.put(
    '/:teamId/plugins/:name',
    { onRequest: teamAdmin, schema: { params: PluginParams } },
    async (request, reply) => {
      const { name, teamId } = request.params;
      const actor = requireUser(request);
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
      const profile = await fastify.prisma.harnessProfile.findUnique({
        select: { id: true, status: true },
        where: { name },
      });
      if (!profile) {
        return sendError(reply, 404, 'NOT_FOUND', 'Plugin not found');
      }
      if (profile.status !== 'OK') {
        return sendError(
          reply,
          409,
          'HARNESS_PROFILE_DISABLED',
          'This plugin is disabled by a platform admin'
        );
      }
      const prior = await fastify.prisma.pluginEnablement.findFirst({
        select: { createdAt: true },
        where: { profileId: profile.id, teamId },
      });
      if (prior) {
        return { data: { enabled: true, enabledAt: prior.createdAt.toISOString(), name } };
      }
      try {
        const row = await fastify.prisma.pluginEnablement.create({
          data: { enabledById: actor.sub, profileId: profile.id, teamId },
          select: { createdAt: true },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: { enabled: true, plugin: name, teamId },
          entityId: profile.id,
          entityType: 'PluginEnablement',
        });
        return { data: { enabled: true, enabledAt: row.createdAt.toISOString(), name } };
      } catch (err) {
        // Two admins enabling at once: the other one's row is the answer.
        if (isUniqueConstraintError(err)) {
          return { data: { enabled: true, enabledAt: null, name } };
        }
        throw err;
      }
    }
  );

  app.delete(
    '/:teamId/plugins/:name',
    { onRequest: teamAdmin, schema: { params: PluginParams } },
    async (request, reply) => {
      const { name, teamId } = request.params;
      const actor = requireUser(request);
      const profile = await fastify.prisma.harnessProfile.findUnique({
        select: { id: true },
        where: { name },
      });
      if (!profile) {
        return sendError(reply, 404, 'NOT_FOUND', 'Plugin not found');
      }
      const { count } = await fastify.prisma.pluginEnablement.deleteMany({
        where: { profileId: profile.id, teamId },
      });
      if (count === 0) {
        return sendError(reply, 404, 'NOT_FOUND', 'This plugin is not enabled for the team');
      }
      // Allowed while agents are bound; they are named so nobody finds out from a failed run.
      const strandedAgents = (
        await boundAgentsForProfile(fastify.prisma, { id: profile.id, name }, { teamId })
      ).map((a) => ({ key: a.key, version: a.version }));
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        before: { enabled: true, plugin: name, strandedAgents: strandedAgents.length, teamId },
        entityId: profile.id,
        entityType: 'PluginEnablement',
      });
      return { data: { enabled: false, name, strandedAgents } };
    }
  );
};
