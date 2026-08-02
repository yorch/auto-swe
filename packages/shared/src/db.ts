import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { tenantGuardExtension } from './lib/tenantGuard.js';

// Re-export PrismaClient for use by other packages
export { PrismaClient } from './generated/prisma/client.js';

// Singleton PrismaClient — shared across the process.
// Import as: import { prisma } from '@auto-swe/shared/db';
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const base = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  // The tenant guard lives here rather than on the gateway's Fastify decoration,
  // so every consumer of this singleton gets it. Attaching it downstream made
  // coverage an artifact of which file called `$extends`: the worker ran
  // unguarded, and it is the half that puts `MemoryItem` rows into an agent
  // prompt. See `lib/tenantGuard.ts` for what it covers and what it does not.
  return base.$extends(tenantGuardExtension()) as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
