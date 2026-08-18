vi.mock('@auto-swe/shared/db', () => ({
  PrismaClient: vi.fn(),
  prisma: {},
}));

import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scannerPatternRoutes } from './scannerPatterns.js';

const EXISTING = {
  flags: '',
  id: '11111111-1111-4111-8111-111111111111',
  isActive: true,
  isBuiltIn: false,
  label: 'custom',
  pattern: 'safe',
  type: 'INJECTION',
};

function newMockPrisma() {
  return {
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    scannerPattern: {
      create: vi.fn().mockImplementation(({ data }: { data: object }) => ({ id: 'new', ...data })),
      delete: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(EXISTING),
      update: vi
        .fn()
        .mockImplementation(({ data }: { data: object }) => ({ ...EXISTING, ...data })),
    },
  };
}

let prisma: ReturnType<typeof newMockPrisma>;

async function buildApp() {
  prisma = newMockPrisma();
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ADMIN', sub: 'admin-1' }),
  } as unknown as never);
  await app.register(scannerPatternRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  return app;
}

const AUTH = { authorization: 'Bearer fake' };

const create = async (body: Record<string, unknown>) => {
  const app = await buildApp();
  const res = await app.inject({
    body,
    headers: AUTH,
    method: 'POST',
    url: '/api/v1/admin/scanner-patterns',
  });
  await app.close();
  return res;
};

beforeEach(() => vi.clearAllMocks());

describe('POST /admin/scanner-patterns — ReDoS gate', () => {
  it.each(['(a+)+$', '([a-z]+)*!', '(a|ab)+'])(
    'rejects the catastrophic pattern %j without writing it',
    async (pattern) => {
      const res = await create({ flags: 'i', label: 'evil', pattern, type: 'INJECTION' });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('REDOS_RISK');
      expect(body.error.message).toMatch(/catastrophic backtracking/);
      expect(prisma.scannerPattern.create).not.toHaveBeenCalled();
    }
  );

  it('still accepts an ordinary pattern', async () => {
    const res = await create({
      flags: 'i',
      label: 'ok',
      pattern: 'ignore\\s+(all\\s+)?previous\\s+instructions',
      type: 'INJECTION',
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.scannerPattern.create).toHaveBeenCalledTimes(1);
  });

  it('keeps the INVALID_REGEX code for an uncompilable pattern', async () => {
    const res = await create({ label: 'broken', pattern: '(', type: 'INJECTION' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('INVALID_REGEX');
  });

  it('rejects stateful flags at schema validation', async () => {
    const res = await create({ flags: 'g', label: 'x', pattern: 'a', type: 'INJECTION' });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /admin/scanner-patterns/:id — ReDoS gate', () => {
  it('rejects an update that turns a safe pattern catastrophic', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { pattern: '(x+)+y' },
      headers: AUTH,
      method: 'PUT',
      url: `/api/v1/admin/scanner-patterns/${EXISTING.id}`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('REDOS_RISK');
    expect(prisma.scannerPattern.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('allows a safe update', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { pattern: 'x+y' },
      headers: AUTH,
      method: 'PUT',
      url: `/api/v1/admin/scanner-patterns/${EXISTING.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.scannerPattern.update).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
