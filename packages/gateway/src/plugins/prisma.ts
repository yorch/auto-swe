import { PrismaClient } from '@auto-swe/shared';
import { tenantGuardExtension } from '@auto-swe/shared/lib/tenantGuard';
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
  const base = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  await base.$connect();

  // Defence in depth: org/team checks live on the routes, so a handler that
  // forgets its filter is a data-exposure bug nothing else catches. The guard
  // fails a multi-row query on a tenant-scoped model that carries no tenant
  // predicate. Genuinely global queries opt out with `runUnscoped(reason, models, fn)`,
  // which exempts only the models it names.
  //
  // It warns rather than throws in production: a violation should stop a test,
  // but should not take a running deployment down over a query that has been
  // serving traffic. See `lib/tenantGuard.ts`.
  const prisma = base.$extends(tenantGuardExtension()) as unknown as PrismaClient;

  fastify.decorate('prisma', prisma);

  fastify.addHook('onClose', async () => {
    await base.$disconnect();
  });
};

export { prismaPlugin };
export default fp(prismaPlugin, { fastify: '5.x', name: 'prisma' });
