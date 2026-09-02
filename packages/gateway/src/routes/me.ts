import { RUN_DETAIL_LAYOUTS } from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
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
};
