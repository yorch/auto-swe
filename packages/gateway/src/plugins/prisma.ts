import type { PrismaClient } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

/**
 * Decorates Fastify with the shared client rather than building a second one.
 *
 * The tenant guard is applied once, in `@auto-swe/shared/db`'s factory. A
 * separate `new PrismaClient()` here would be unguarded — and would also open a
 * second connection pool in the same process, since `betterAuth`, the
 * system-config routes and the webhook routes already import the singleton.
 * One client, one pool, one guard.
 */
const prismaPlugin: FastifyPluginAsync = async (fastify) => {
  await prisma.$connect();

  fastify.decorate('prisma', prisma);

  fastify.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
};

export { prismaPlugin };
export default fp(prismaPlugin, { fastify: '5.x', name: 'prisma' });
