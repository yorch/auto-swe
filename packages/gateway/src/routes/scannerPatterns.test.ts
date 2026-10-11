vi.mock('@auto-swe/shared/db', () => ({
  PrismaClient: vi.fn(),
  prisma: {},
}));

import {
  isRegexQuarantined,
  resetRegexExecutor,
  runRegexBatch,
} from '@auto-swe/shared/lib/regexExec';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

async function buildApp(role = 'ADMIN') {
  prisma = newMockPrisma();
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(scannerPatternRoutes, { prefix: '/api/v1/platform' });
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
    url: '/api/v1/platform/scanner-patterns',
  });
  await app.close();
  return res;
};

beforeEach(() => vi.clearAllMocks());

describe('POST /admin/scanner-patterns — ReDoS gate', () => {
  // The gate is empirical: the candidate is executed under the scanners' own
  // wall-clock budget against repetition-heavy input built from its alphabet.
  it.each(['(a+)+$', '([a-z]+)*!', '(a+){1,50}$', '(w+)+$'])(
    'rejects the catastrophic pattern %j without writing it',
    async (pattern) => {
      const res = await create({ flags: 'i', label: 'evil', pattern, type: 'INJECTION' });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('REDOS_RISK');
      expect(body.error.message).toMatch(/execution budget/);
      expect(prisma.scannerPattern.create).not.toHaveBeenCalled();
    }
  );

  // Each of these was rejected by the deleted structural analyser; two of them
  // are regexes this repo itself hardcodes in `shellCommandScanner.ts`, so an
  // admin could not add a rule the codebase already ships.
  it.each([
    'ignore\\s+(all\\s+)?previous\\s+instructions',
    '(?:\\w+\\.)+\\w+',
    '(?:\\d+\\.)+\\d+',
    '(?:[^,]+,)+[^,]+',
    '(foo|bar|baz)+',
    '(a|ab)+',
    '\\btee\\b(?:\\s+(?:-a|--append|-i|--ignore-interrupts))*\\s+(?:\'([^\']+)\'|"([^"]+)"|([^\\s;&|)<>\'"-][^\\s;&|)<>\'"]*))',
    '\\b(?:cp|mv|install)\\b((?:\\s+(?:-[^\\s;&|]+|\'[^\']+\'|"[^"]+"|[^\\s;&|)<>\'"]+))+)',
  ])('still accepts the ordinary pattern %j', async (pattern) => {
    const res = await create({ flags: 'i', label: 'ok', pattern, type: 'INJECTION' });
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
      url: `/api/v1/platform/scanner-patterns/${EXISTING.id}`,
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
      url: `/api/v1/platform/scanner-patterns/${EXISTING.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.scannerPattern.update).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('POST /scanner-patterns/test — try a pattern', () => {
  afterEach(() => resetRegexExecutor());

  const test = async (body: Record<string, unknown>, role = 'ADMIN') => {
    const app = await buildApp(role);
    const res = await app.inject({
      body,
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/scanner-patterns/test',
    });
    const writes = [
      prisma.scannerPattern.create,
      prisma.scannerPattern.update,
      prisma.scannerPattern.delete,
      prisma.configAuditLog.create,
    ];
    await app.close();
    return { res, writes };
  };

  it('reports a match with a bounded excerpt, and a miss, per sample, writing nothing', async () => {
    const { res, writes } = await test({
      flags: 'i',
      pattern: 'ignore\\s+previous',
      samples: ['Please IGNORE   previous rules', 'harmless text'],
    });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.payload);
    expect(data.budgetMs).toBeGreaterThan(0);
    expect(data.results).toEqual([
      {
        index: 0,
        match: { excerpt: 'IGNORE   previous', length: 17, truncated: false },
        matched: true,
        status: 'matched',
      },
      { index: 1, match: null, matched: false, status: 'no_match' },
    ]);
    for (const w of writes) {
      expect(w).not.toHaveBeenCalled();
    }
  });

  it('truncates a long match to the excerpt bound but reports its full length', async () => {
    const { res } = await test({ pattern: 'a+', samples: ['a'.repeat(5000)] });
    const [r] = JSON.parse(res.payload).data.results;
    expect(r.match.excerpt).toHaveLength(200);
    expect(r.match.length).toBe(5000);
    expect(r.match.truncated).toBe(true);
  });

  it('answers INVALID_REGEX for an uncompilable pattern', async () => {
    const { res } = await test({ pattern: '(', samples: ['x'] });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('INVALID_REGEX');
  });

  it.each(['g', 'y'])('refuses the stateful flag %s', async (flags) => {
    const { res } = await test({ flags, pattern: 'a', samples: ['a'] });
    expect(res.statusCode).toBe(400);
  });

  it('answers REDOS_RISK for a catastrophic pattern, as create does', async () => {
    const { res } = await test({ pattern: '(a+)+$', samples: ['aaaa'] });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('REDOS_RISK');
  });

  it('refuses too many samples, an oversize sample and an empty list', async () => {
    expect((await test({ pattern: 'a', samples: Array(11).fill('a') })).res.statusCode).toBe(400);
    expect((await test({ pattern: 'a', samples: ['a'.repeat(20_001)] })).res.statusCode).toBe(400);
    expect((await test({ pattern: 'a', samples: [] })).res.statusCode).toBe(400);
  });

  it('refuses a non-admin', async () => {
    const { res } = await test({ pattern: 'a', samples: ['a'] }, 'ENGINEER');
    expect(res.statusCode).toBe(403);
  });

  describe('with a pinned 150 ms budget', () => {
    beforeEach(() => {
      vi.stubEnv('SCANNER_REGEX_BUDGET_MS', '150');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    // Quadratic, so the write-time probe (short inputs) accepts it; 20k chars overruns.
    const SLOW = `${'a'.repeat(19_999)}!`;

    it('reports an overrun as a result, not a 500, and does not quarantine the rule', async () => {
      const first = await test({ pattern: 'a+a+$', samples: [SLOW, 'b'] });
      expect(first.res.statusCode).toBe(200);
      const data = JSON.parse(first.res.payload).data;
      expect(data.budgetMs).toBe(150);
      expect(data.results[0]).toEqual({
        index: 0,
        match: null,
        matched: false,
        status: 'timed_out',
      });
      // Not skipped for having overrun a moment ago: the next sample is evaluated.
      expect(data.results[1].status).toBe('no_match');
      expect(isRegexQuarantined('a+a+$', '')).toBe(false);
      // A normal scan still runs the rule rather than skipping it.
      const scan = await runRegexBatch(
        [{ flags: '', key: 'k', source: 'a+a+$' }],
        [
          { key: 't', text: 'aa!' },
          { key: 'u', text: 'aaa' },
        ]
      );
      expect(scan.quarantinedPatternKeys).toEqual([]);
      expect(scan.hits.map((h) => h.targetKey)).toEqual(['u']);
    }, 20_000);

    it('stops after the total time cap and reports the rest as not_run', async () => {
      const { res } = await test({ pattern: 'a+a+$', samples: [SLOW, SLOW, SLOW, 'b'] });
      const data = JSON.parse(res.payload).data;
      expect(data.totalCapMs).toBe(450);
      expect(data.results.map((r: { status: string }) => r.status)).toEqual([
        'timed_out',
        'timed_out',
        'not_run',
        'not_run',
      ]);
    }, 20_000);
  });
});
