import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { readDueSoonHours } from '../lib/dueSoonHours.js';
import { sendError } from '../lib/httpErrors.js';
import { buildTeamOverview } from '../lib/teamOverview.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/** One team's landing page: counts and lists scoped to that team, with more for a lead or admin. */
export const teamOverviewRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/teams/:id/overview. A non-member gets the same 404 as an unknown team (a platform
  // ADMIN passes). The lead and admin sections exist in the response only for a viewer whose TEAM
  // role allows them; the platform role never raises it.
  app.get(
    '/:id/overview',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const overview = await buildTeamOverview(
        {
          dueSoonHours: await readDueSoonHours(request.log),
          gate: request.repoAccessGate,
          prisma: fastify.prisma,
          user,
        },
        request.params.id
      );
      if (!overview) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }
      return { data: overview };
    }
  );
};
