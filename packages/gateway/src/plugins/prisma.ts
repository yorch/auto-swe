import { PrismaClient } from '@auto-swe/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

const prismaPlugin: FastifyPluginAsync = async (fastify) => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  // The tenant guard is applied in `@auto-swe/shared/db`'s factory, so this
  // client carries it too — and so does the module-level singleton that a few
  // gateway modules import directly. Keeping the `$extends` here would have
  // made the two differ, which is exactly how the worker ended up unguarded.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  await prisma.$connect();

  fastify.decorate('prisma', prisma);

  fastify.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
};

export { prismaPlugin };
export default fp(prismaPlugin, { fastify: '5.x', name: 'prisma' });
