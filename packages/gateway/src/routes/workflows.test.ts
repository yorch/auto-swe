import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubBaseUrl: vi.fn().mockResolvedValue('https://github.com'),
}));

import { workflowRoutes } from './workflows.js';

// A ledger row as Prisma returns it: every token counter is a BigInt, which
// Fastify's JSON serializer cannot write.
const ROW = {
  id: 'aw-1',
  pullRequests: [],
  repository: null,
  tokensInputCountedUsed: 190_000n,
  tokensInputUsed: 1_000_000n,
  tokensOutputUsed: 50n,
};

async function get(url: string) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    activeWorkflow: {
      count: vi.fn().mockResolvedValue(1),
      findFirst: vi.fn().mockResolvedValue(ROW),
      findMany: vi.fn().mockResolvedValue([ROW]),
    },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ADMIN', sub: 'u-1' }),
  } as unknown as never);
  await app.register(workflowRoutes, { prefix: '/api/v1/workflows' });
  await app.ready();
  return app.inject({ headers: { authorization: 'Bearer fake' }, method: 'GET', url });
}

describe('workflow routes with BigInt token counters', () => {
  it('lists the raw token totals and leaves out the budget-only counted column', async () => {
    const res = await get('/api/v1/workflows');

    expect(res.statusCode).toBe(200);
    const [row] = res.json().data;
    expect(row.tokensInputUsed).toBe(1_000_000);
    expect(row.tokensOutputUsed).toBe(50);
    expect(row).not.toHaveProperty('tokensInputCountedUsed');
  });

  it('returns one workflow the same way', async () => {
    const res = await get('/api/v1/workflows/0b1c2d3e-0000-4000-8000-000000000000');

    expect(res.statusCode).toBe(200);
    expect(res.json().data.tokensInputUsed).toBe(1_000_000);
    expect(res.json().data).not.toHaveProperty('tokensInputCountedUsed');
  });
});
