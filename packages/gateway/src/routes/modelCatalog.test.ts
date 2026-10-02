import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/modelSuggestions', () => ({
  runModelDiscovery: vi.fn(async () => ({
    results: [
      {
        complete: true,
        models: [{ displayName: null, kind: 'CHAT', modelId: 'gpt-6.2', spec: 'openai/gpt-6.2' }],
        ok: true,
        provider: 'openai',
        retirementCandidates: [],
      },
    ],
    summary: { providers: [] },
  })),
}));

import { modelCatalogRoutes } from './modelCatalog.js';

const BUILTIN_ID = '00000000-0000-4000-a000-0000000000b1';
const CUSTOM_ID = '00000000-0000-4000-a000-0000000000c1';

interface Row {
  id: string;
  provider: string;
  modelId: string;
  kind: string;
  status: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  isBuiltIn: boolean;
  isCustomized: boolean;
}

function seedRows(): Row[] {
  return [
    {
      id: BUILTIN_ID,
      inputUsdPerMTok: 4,
      isBuiltIn: true,
      isCustomized: false,
      kind: 'CHAT',
      modelId: 'claude-opus-5-5',
      outputUsdPerMTok: 20,
      provider: 'anthropic',
      status: 'ACTIVE',
    },
    {
      id: CUSTOM_ID,
      inputUsdPerMTok: 0,
      isBuiltIn: false,
      isCustomized: false,
      kind: 'CHAT',
      modelId: 'llama-4',
      outputUsdPerMTok: 0,
      provider: 'ollama',
      status: 'RETIRED',
    },
  ];
}

const SUGGESTION_ID = '00000000-0000-4000-a000-0000000000e1';

function seedSuggestions() {
  const base = {
    dismissedAt: null,
    displayName: null,
    firstSeenAt: new Date('2026-10-01T00:00:00Z'),
    kind: 'CHAT',
    lastSeenAt: new Date('2026-10-02T00:00:00Z'),
  };
  return [
    { ...base, id: SUGGESTION_ID, modelId: 'gpt-6.2', provider: 'openai', type: 'NEW' },
    // Priced since the last run: the list must not show it as new.
    { ...base, id: 'b', modelId: 'claude-opus-5-5', provider: 'anthropic', type: 'NEW' },
    {
      ...base,
      dismissedAt: new Date(),
      id: 'c',
      modelId: 'old-1',
      provider: 'openai',
      type: 'NEW',
    },
  ];
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const rows = seedRows();
  const suggestions = seedSuggestions();
  const audit = vi.fn().mockResolvedValue({});
  const prisma = {
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    agentTrace: { findMany: vi.fn().mockResolvedValue([{ model: 'openai/gpt-5-5' }]) },
    configAuditLog: { create: audit },
    embeddingConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    modelCatalogEntry: {
      create: vi.fn(
        async ({ data }: { data: Omit<Row, 'id' | 'kind' | 'status'> & Partial<Row> }) => {
          if (rows.some((r) => r.provider === data.provider && r.modelId === data.modelId)) {
            throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          }
          const row = {
            id: '00000000-0000-4000-a000-0000000000d1',
            kind: 'CHAT',
            status: 'ACTIVE',
            ...data,
          };
          rows.push(row);
          return row;
        }
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows.splice(
          rows.findIndex((r) => r.id === where.id),
          1
        );
        return {};
      }),
      findMany: vi.fn(async ({ where }: { where?: { status?: unknown; kind?: string } } = {}) =>
        rows.filter(
          (r) =>
            (!where?.kind || r.kind === where.kind) && (!where?.status || r.status !== 'RETIRED')
        )
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id) ? { ...rows.find((r) => r.id === where.id) } : null
      ),
      update: vi.fn(async ({ data, where }: { data: Partial<Row>; where: { id: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row ?? {}, data);
        return { ...row };
      }),
    },
    modelDiscoveryProviderStatus: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { checkedAt: new Date(), error: 'HTTP 401', lastSuccessAt: null, provider: 'anthropic' },
        ]),
    },
    modelSuggestion: {
      findMany: vi.fn(async ({ where }: { where: { dismissedAt?: null } }) =>
        suggestions.filter((r) => !('dismissedAt' in where) || r.dismissedAt === null)
      ),
      update: vi.fn(
        async ({ data, where }: { data: { dismissedAt: Date | null }; where: { id: string } }) => {
          const row = suggestions.find((r) => r.id === where.id);
          if (!row) {
            throw Object.assign(new Error('not found'), { code: 'P2025' });
          }
          row.dismissedAt = data.dismissedAt;
          return { ...row };
        }
      ),
    },
  };
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(modelCatalogRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      headers: { authorization: 'Bearer token' },
      method,
      payload: payload as never,
      url: `/api/v1/platform${url}`,
    });
  return { audit, call, rows };
}

describe('GET /model-catalog', () => {
  it('lets any signed-in user read it, hiding retired models unless asked', async () => {
    const { call } = await buildApp('ENGINEER');
    const res = await call('GET', '/model-catalog');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((r: Row) => r.modelId)).toEqual(['claude-opus-5-5']);
    const all = await call('GET', '/model-catalog?includeRetired=true');
    expect(all.json().data).toHaveLength(2);
  });

  it('reads includeRetired=false as false, not as a truthy string', async () => {
    const { call } = await buildApp();
    const res = await call('GET', '/model-catalog?includeRetired=false');
    expect(res.json().data).toHaveLength(1);
  });

  it('attaches the shipped values to a built-in row, and none to a custom one', async () => {
    const { call } = await buildApp();
    const [builtin] = (await call('GET', '/model-catalog?includeRetired=true')).json().data;
    expect(builtin.builtin).toEqual({
      inputUsdPerMTok: 4,
      kind: 'CHAT',
      outputUsdPerMTok: 20,
      status: 'ACTIVE',
    });
    const custom = (await call('GET', '/model-catalog?includeRetired=true')).json().data[1];
    expect(custom.builtin).toBeNull();
  });
});

describe('writes are ADMIN-only', () => {
  it('refuses an ENGINEER on every write and on the unpriced report', async () => {
    const { call } = await buildApp('ENGINEER');
    const body = { inputUsdPerMTok: 1, modelId: 'x', outputUsdPerMTok: 1, provider: 'acme' };
    expect((await call('POST', '/model-catalog', body)).statusCode).toBe(403);
    expect((await call('PUT', `/model-catalog/${CUSTOM_ID}`, { notes: 'x' })).statusCode).toBe(403);
    expect((await call('POST', `/model-catalog/${BUILTIN_ID}/reset`)).statusCode).toBe(403);
    expect((await call('DELETE', `/model-catalog/${CUSTOM_ID}`)).statusCode).toBe(403);
    expect((await call('GET', '/model-catalog/unpriced')).statusCode).toBe(403);
  });
});

describe('POST /model-catalog', () => {
  it('creates a custom row, audited', async () => {
    const { audit, call } = await buildApp();
    const res = await call('POST', '/model-catalog', {
      inputUsdPerMTok: 0.5,
      modelId: 'qwen-3',
      outputUsdPerMTok: 1,
      provider: 'vllm',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ isBuiltIn: false, modelId: 'qwen-3' });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate spec with 409', async () => {
    const { call } = await buildApp();
    const res = await call('POST', '/model-catalog', {
      inputUsdPerMTok: 1,
      modelId: 'llama-4',
      outputUsdPerMTok: 1,
      provider: 'ollama',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MODEL_EXISTS');
  });

  it('rejects a negative price, an uppercase provider, and whitespace in the model id', async () => {
    const { call } = await buildApp();
    const ok = { inputUsdPerMTok: 1, modelId: 'm', outputUsdPerMTok: 1, provider: 'acme' };
    expect((await call('POST', '/model-catalog', { ...ok, inputUsdPerMTok: -1 })).statusCode).toBe(
      400
    );
    expect((await call('POST', '/model-catalog', { ...ok, provider: 'Acme' })).statusCode).toBe(
      400
    );
    expect((await call('POST', '/model-catalog', { ...ok, modelId: 'gpt 5' })).statusCode).toBe(
      400
    );
  });
});

describe('PUT /model-catalog/:id', () => {
  it('marks a built-in row customized on any edit, so startup seeding keeps it', async () => {
    const { audit, call, rows } = await buildApp();
    const res = await call('PUT', `/model-catalog/${BUILTIN_ID}`, { inputUsdPerMTok: 3.5 });
    expect(res.statusCode).toBe(200);
    expect(rows[0]).toMatchObject({ inputUsdPerMTok: 3.5, isCustomized: true });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('leaves a custom row uncustomized, and never changes provider or modelId', async () => {
    const { call, rows } = await buildApp();
    await call('PUT', `/model-catalog/${CUSTOM_ID}`, {
      modelId: 'renamed',
      provider: 'other',
      status: 'ACTIVE',
    });
    expect(rows[1]).toMatchObject({
      isCustomized: false,
      modelId: 'llama-4',
      provider: 'ollama',
      status: 'ACTIVE',
    });
  });

  it('404s on an unknown id', async () => {
    const { call } = await buildApp();
    const res = await call('PUT', '/model-catalog/00000000-0000-4000-a000-0000000000ff', {
      notes: 'x',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /model-catalog/:id/reset', () => {
  it('restores a customized built-in to the shipped values and clears the flag', async () => {
    const { call, rows } = await buildApp();
    await call('PUT', `/model-catalog/${BUILTIN_ID}`, {
      inputUsdPerMTok: 3.5,
      status: 'DEPRECATED',
    });
    const res = await call('POST', `/model-catalog/${BUILTIN_ID}/reset`);
    expect(res.statusCode).toBe(200);
    expect(rows[0]).toMatchObject({ inputUsdPerMTok: 4, isCustomized: false, status: 'ACTIVE' });
  });

  it('refuses a row that does not ship built-in', async () => {
    const { call } = await buildApp();
    const res = await call('POST', `/model-catalog/${CUSTOM_ID}/reset`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_BUILT_IN');
  });
});

describe('DELETE /model-catalog/:id', () => {
  it('refuses a built-in row — startup would re-create it', async () => {
    const { call, rows } = await buildApp();
    const res = await call('DELETE', `/model-catalog/${BUILTIN_ID}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BUILT_IN_MODEL');
    expect(rows).toHaveLength(2);
  });

  it('deletes a custom row, audited', async () => {
    const { audit, call, rows } = await buildApp();
    expect((await call('DELETE', `/model-catalog/${CUSTOM_ID}`)).statusCode).toBe(200);
    expect(rows).toHaveLength(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });
});

describe('GET /model-catalog/unpriced', () => {
  it('reports a spec in use that nothing prices, with its likely intended spec', async () => {
    const { call } = await buildApp();
    const res = await call('GET', '/model-catalog/unpriced');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { spec: 'openai/gpt-5-5', suggestion: 'openai/gpt-5.5', usedBy: ['recent-calls'] },
    ]);
  });
});

describe('POST /model-catalog/discover', () => {
  it('is ADMIN-only — it calls providers with decrypted keys', async () => {
    const { call } = await buildApp('ENGINEER');
    expect((await call('POST', '/model-catalog/discover')).statusCode).toBe(403);
  });

  it('returns what each provider lists that nothing prices', async () => {
    const { call } = await buildApp();
    const res = await call('POST', '/model-catalog/discover');
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0]).toMatchObject({ ok: true, provider: 'openai' });
  });
});

describe('model suggestions', () => {
  it('are ADMIN-only to read and to dismiss', async () => {
    const { call } = await buildApp('ENGINEER');
    expect((await call('GET', '/model-catalog/suggestions')).statusCode).toBe(403);
    expect(
      (await call('POST', `/model-catalog/suggestions/${SUGGESTION_ID}/dismiss`)).statusCode
    ).toBe(403);
  });

  it('lists undismissed ones with last-run status, and drops a NEW one that is priced now', async () => {
    const { call } = await buildApp();
    const res = await call('GET', '/model-catalog/suggestions');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.suggestions.map((s: { spec: string }) => s.spec)).toEqual([
      'openai/gpt-6.2',
    ]);
    expect(res.json().data.providers[0]).toMatchObject({
      error: 'HTTP 401',
      provider: 'anthropic',
    });
  });

  it('dismisses and undismisses one, and 404s on an unknown id', async () => {
    const { call } = await buildApp();
    const dismissed = await call('POST', `/model-catalog/suggestions/${SUGGESTION_ID}/dismiss`);
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json().data.dismissedAt).not.toBeNull();
    expect((await call('GET', '/model-catalog/suggestions')).json().data.suggestions).toEqual([]);
    const all = await call('GET', '/model-catalog/suggestions?includeDismissed=true');
    expect(all.json().data.suggestions).toHaveLength(2);
    const undone = await call('POST', `/model-catalog/suggestions/${SUGGESTION_ID}/undismiss`);
    expect(undone.json().data.dismissedAt).toBeNull();
    const missing = await call(
      'POST',
      '/model-catalog/suggestions/00000000-0000-4000-a000-0000000000ff/dismiss'
    );
    expect(missing.statusCode).toBe(404);
  });
});

describe('GET /model-catalog/role-pricing', () => {
  it('is readable by any signed-in user — the editor shows estimates to template authors', async () => {
    const { call } = await buildApp('ENGINEER');
    const res = await call('GET', '/model-catalog/role-pricing');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('data');
  });
});
