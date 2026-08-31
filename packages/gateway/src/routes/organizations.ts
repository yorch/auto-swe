import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

export const organizationRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // List organizations the current user is a member of.
  app.get('/', { onRequest: requireAuth({ requiredRole: 'LEAD' }) }, async (request) => {
    const user = requireUser(request);
    const rows = await fastify.prisma.organizationMembership.findMany({
      orderBy: { organization: { name: 'asc' } },
      select: {
        organization: { select: { id: true, name: true, slug: true } },
        role: true,
      },
      where: { userId: user.sub },
    });
    return {
      data: rows.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        role: m.role,
        slug: m.organization.slug,
      })),
    };
  });
};
