import fp from 'fastify-plugin';
import { PrismaClient } from '@auto-swe/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import type { FastifyPluginAsync } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

const prismaPlugin: FastifyPluginAsync = async (fastify) => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
    }),
  });
  await prisma.$connect();

  fastify.decorate('prisma', prisma);

  fastify.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
};

export { prismaPlugin };
export default fp(prismaPlugin, { fastify: '5.x', name: 'prisma' });
