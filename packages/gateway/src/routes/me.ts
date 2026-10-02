import { resolveSettings } from '@auto-swe/shared/config';
import { RUN_DETAIL_LAYOUTS } from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { listMcpGrants, revokeMcpGrants } from '../lib/mcpGrants.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const PreferencesBodySchema = z.object({
  runDetailLayout: z.enum(RUN_DETAIL_LAYOUTS).optional(),
});

export const meRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/me/preferences
  app.get(
    '/preferences',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) },
    async (request) => {
      const { sub } = requireUser(request);
      const user = await fastify.prisma.user.findUniqueOrThrow({
        select: { preferences: true },
        where: { id: sub },
      });
      return { preferences: user.preferences };
    }
  );

  // PATCH /api/v1/me/preferences
  app.patch(
    '/preferences',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: PreferencesBodySchema },
    },
    async (request) => {
      const { sub } = requireUser(request);
      const existing = await fastify.prisma.user.findUniqueOrThrow({
        select: { preferences: true },
        where: { id: sub },
      });
      const existingPrefs =
        existing.preferences !== null &&
        typeof existing.preferences === 'object' &&
        !Array.isArray(existing.preferences)
          ? (existing.preferences as Record<string, unknown>)
          : {};
      const merged = { ...existingPrefs, ...request.body };
      const updated = await fastify.prisma.user.update({
        data: { preferences: merged },
        select: { preferences: true },
        where: { id: sub },
      });
      return { preferences: updated.preferences };
    }
  );

  // GET /api/v1/me/mcp-grants: the MCP clients the caller has authorised. `mcp` carries the
  // operator switches the consent screen and the settings page need to tell the user what
  // can be granted; reading it here keeps the OAuth endpoints themselves free of lookups.
  app.get(
    '/mcp-grants',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) },
    async (request) => {
      const { sub } = requireUser(request);
      const [grants, settings] = await Promise.all([
        listMcpGrants(fastify.prisma, sub),
        resolveSettings(['mcp.enabled', 'mcp.writeToolsEnabled']),
      ]);
      return {
        data: grants,
        mcp: {
          enabled: settings['mcp.enabled'],
          writeToolsEnabled: settings['mcp.writeToolsEnabled'],
        },
      };
    }
  );

  // DELETE /api/v1/me/mcp-grants/:clientId: the caller's own grant to one client, durably
  // (refresh and access tokens included). Deliberately independent of `mcp.enabled`: a user
  // can always take access back.
  app.delete(
    '/mcp-grants/:clientId',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: z.object({ clientId: z.string().min(1).max(256) }) },
    },
    async (request, reply) => {
      const { sub } = requireUser(request);
      const revoked = await revokeMcpGrants(fastify.prisma, {
        actorId: sub,
        clientId: request.params.clientId,
        userId: sub,
      });
      if (!revoked) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'No such connected app' } });
      }
      return reply.status(204).send();
    }
  );
};
