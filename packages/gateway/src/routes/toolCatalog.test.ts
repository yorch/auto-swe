import { BUILTIN_TOOLS } from '@auto-swe/shared/lib/toolCatalog';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { toolCatalogRoutes } from './toolCatalog.js';

const BUILTIN_ID = '00000000-0000-4000-a000-0000000000b1';
const CUSTOM_ID = '00000000-0000-4000-a000-0000000000c1';
const MISSING_ID = '00000000-0000-4000-a000-0000000000ff';

const JUST = BUILTIN_TOOLS[0];
if (!JUST) {
  throw new Error('fixture: BUILTIN_TOOLS is empty');
}

const SHA = 'a'.repeat(64);
const ARCHS = { amd64: { sha256: SHA, url: 'https://example.com/jq-1.7.1.tar.gz' } };
const NEW_TOOL = { archs: ARCHS, key: 'jq', libc: 'any', member: 'bin/jq', version: '1.7.1' };

interface Row {
  id: string;
  key: string;
  version: string;
  archs: unknown;
  member: string;
  libc: string;
  description: string | null;
  status: string;
  notes: string | null;
  isBuiltIn: boolean;
  isCustomized: boolean;
}

function seedRows(): Row[] {
  const base = { description: null, isCustomized: false, notes: null, status: 'ACTIVE' };
  return [
    {
      ...base,
      archs: JUST.archs,
      id: BUILTIN_ID,
      isBuiltIn: true,
      key: JUST.key,
      libc: JUST.libc,
      member: JUST.member,
      version: JUST.version,
    },
    {
      ...base,
      archs: ARCHS,
      id: CUSTOM_ID,
      isBuiltIn: false,
      key: 'ripgrep',
      libc: 'musl',
      member: 'rg',
      status: 'REVOKED',
      version: '14.1.0',
    },
  ];
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const rows = seedRows();
  const audit = vi.fn().mockResolvedValue({});
  const prisma = {
    configAuditLog: { create: audit },
    toolCatalogEntry: {
      create: vi.fn(async ({ data }: { data: Omit<Row, 'id'> }) => {
        if (rows.some((r) => r.key === data.key && r.version === data.version)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const row: Row = {
          ...data,
          description: data.description ?? null,
          id: '00000000-0000-4000-a000-0000000000d1',
          notes: data.notes ?? null,
          status: data.status ?? 'ACTIVE',
        };
        rows.push(row);
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows.splice(
          rows.findIndex((r) => r.id === where.id),
          1
        );
        return {};
      }),
      findMany: vi.fn(async ({ where }: { where?: { status?: unknown } } = {}) =>
        rows.filter((r) => !where?.status || r.status !== 'REVOKED')
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      }),
      update: vi.fn(async ({ data, where }: { data: Partial<Row>; where: { id: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row ?? {}, data);
        return { ...row };
      }),
      updateMany: vi.fn(
        async ({
          data,
          where,
        }: {
          data: Partial<Row>;
          where: { id: string; status?: Row['status'] };
        }) => {
          const row = rows.find(
            (r) => r.id === where.id && (where.status === undefined || r.status === where.status)
          );
          if (!row) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
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
  await app.register(toolCatalogRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = { authorization: 'Bearer token' }
  ) =>
    app.inject({
      headers,
      method,
      payload: payload as never,
      url: `/api/v1/platform${url}`,
    });
  return { audit, call, prisma, rows };
}

describe('GET /tool-catalog', () => {
  it('lets any signed-in user read it, hiding revoked tools unless asked', async () => {
    const { call } = await buildApp('ENGINEER');
    const res = await call('GET', '/tool-catalog');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((r: Row) => r.key)).toEqual(['just']);
    const all = await call('GET', '/tool-catalog?includeRevoked=true');
    expect(all.json().data).toHaveLength(2);
  });

  it('reads includeRevoked=false as false, not as a truthy string', async () => {
    const { call } = await buildApp();
    const res = await call('GET', '/tool-catalog?includeRevoked=false');
    expect(res.json().data).toHaveLength(1);
  });

  it('refuses an anonymous caller', async () => {
    const { call } = await buildApp();
    expect((await call('GET', '/tool-catalog', undefined, {})).statusCode).toBe(401);
  });

  it('attaches the shipped values to a built-in row, and none to a custom one', async () => {
    const { call } = await buildApp();
    const data = (await call('GET', '/tool-catalog?includeRevoked=true')).json().data;
    expect(data[0].builtin).toEqual({
      archs: JUST.archs,
      description: JUST.description,
      libc: JUST.libc,
      member: JUST.member,
      status: JUST.status,
    });
    expect(data[1].builtin).toBeNull();
  });
});

describe('writes are ADMIN-only', () => {
  it('refuses an ENGINEER on every write', async () => {
    const { audit, call } = await buildApp('ENGINEER');
    expect((await call('POST', '/tool-catalog', NEW_TOOL)).statusCode).toBe(403);
    expect((await call('PUT', `/tool-catalog/${CUSTOM_ID}`, { notes: 'x' })).statusCode).toBe(403);
    expect((await call('POST', `/tool-catalog/${CUSTOM_ID}/revoke`)).statusCode).toBe(403);
    expect((await call('POST', `/tool-catalog/${BUILTIN_ID}/reset`)).statusCode).toBe(403);
    expect((await call('DELETE', `/tool-catalog/${CUSTOM_ID}`)).statusCode).toBe(403);
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses an anonymous caller on every write', async () => {
    const { call } = await buildApp();
    const none = {};
    expect((await call('POST', '/tool-catalog', NEW_TOOL, none)).statusCode).toBe(401);
    expect((await call('PUT', `/tool-catalog/${CUSTOM_ID}`, {}, none)).statusCode).toBe(401);
    expect(
      (await call('POST', `/tool-catalog/${CUSTOM_ID}/revoke`, undefined, none)).statusCode
    ).toBe(401);
    expect(
      (await call('POST', `/tool-catalog/${BUILTIN_ID}/reset`, undefined, none)).statusCode
    ).toBe(401);
    expect((await call('DELETE', `/tool-catalog/${CUSTOM_ID}`, undefined, none)).statusCode).toBe(
      401
    );
  });
});

describe('POST /tool-catalog', () => {
  it('creates a custom row, defaulting to ACTIVE, audited once', async () => {
    const { audit, call } = await buildApp();
    const res = await call('POST', '/tool-catalog', { ...NEW_TOOL, notes: 'for the linter' });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({
      isBuiltIn: false,
      isCustomized: false,
      key: 'jq',
      notes: 'for the linter',
      status: 'ACTIVE',
    });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate key and version with 409', async () => {
    const { audit, call } = await buildApp();
    const res = await call('POST', '/tool-catalog', {
      ...NEW_TOOL,
      key: JUST.key,
      version: JUST.version,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TOOL_EXISTS');
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects malformed entries with 400 instead of coercing them', async () => {
    const { audit, call, rows } = await buildApp();
    const post = async (patch: Record<string, unknown>) =>
      (await call('POST', '/tool-catalog', { ...NEW_TOOL, ...patch })).statusCode;
    expect(await post({ archs: {} })).toBe(400);
    expect(await post({ archs: { riscv: ARCHS.amd64 } })).toBe(400);
    expect(
      await post({ archs: { amd64: { ...ARCHS.amd64, url: 'http://example.com/x.tar.gz' } } })
    ).toBe(400);
    expect(await post({ archs: { amd64: { ...ARCHS.amd64, sha256: 'abc123' } } })).toBe(400);
    expect(await post({ member: '../escape' })).toBe(400);
    expect(await post({ member: 'bin/../../escape' })).toBe(400);
    expect(await post({ member: '/abs/jq' })).toBe(400);
    expect(await post({ key: 'Bad Key' })).toBe(400);
    expect(await post({ libc: 'uclibc' })).toBe(400);
    expect(await post({ status: 'GONE' })).toBe(400);
    expect(rows).toHaveLength(2);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('PUT /tool-catalog/:id', () => {
  it('marks a built-in row customized on any edit, so startup seeding keeps it', async () => {
    const { audit, call, rows } = await buildApp();
    const res = await call('PUT', `/tool-catalog/${BUILTIN_ID}`, { member: 'bin/just' });
    expect(res.statusCode).toBe(200);
    expect(rows[0]).toMatchObject({ isCustomized: true, member: 'bin/just' });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('leaves a custom row uncustomized, and never changes key or version', async () => {
    const { call, rows } = await buildApp();
    const res = await call('PUT', `/tool-catalog/${CUSTOM_ID}`, {
      key: 'renamed',
      status: 'DEPRECATED',
      version: '9.9.9',
    });
    expect(res.statusCode).toBe(200);
    expect(rows[1]).toMatchObject({
      isCustomized: false,
      key: 'ripgrep',
      status: 'DEPRECATED',
      version: '14.1.0',
    });
  });

  it('validates an edited archs map', async () => {
    const { call } = await buildApp();
    const res = await call('PUT', `/tool-catalog/${CUSTOM_ID}`, {
      archs: { amd64: { sha256: 'short', url: 'https://example.com/x.tar.gz' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s on an unknown id', async () => {
    const { call } = await buildApp();
    expect((await call('PUT', `/tool-catalog/${MISSING_ID}`, { notes: 'x' })).statusCode).toBe(404);
  });
});

describe('POST /tool-catalog/:id/revoke', () => {
  it('sets REVOKED, marks a built-in customized, and audits once with before and after', async () => {
    const { audit, call, rows } = await buildApp();
    const res = await call('POST', `/tool-catalog/${BUILTIN_ID}/revoke`);
    expect(res.statusCode).toBe(200);
    expect(rows[0]).toMatchObject({ isCustomized: true, status: 'REVOKED' });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('404s on an unknown id', async () => {
    const { call } = await buildApp();
    expect((await call('POST', `/tool-catalog/${MISSING_ID}/revoke`)).statusCode).toBe(404);
  });
});

describe('POST /tool-catalog/:id/reset', () => {
  it('restores a customized built-in to the shipped values and clears the flag', async () => {
    const { audit, call, rows } = await buildApp();
    await call('PUT', `/tool-catalog/${BUILTIN_ID}`, { member: 'bin/just', status: 'DEPRECATED' });
    const res = await call('POST', `/tool-catalog/${BUILTIN_ID}/reset`);
    expect(res.statusCode).toBe(200);
    expect(rows[0]).toMatchObject({
      archs: JUST.archs,
      isCustomized: false,
      member: JUST.member,
      status: 'ACTIVE',
    });
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it('keeps a REVOKED row revoked, says so, and audits it', async () => {
    const { audit, call, rows } = await buildApp();
    await call('POST', `/tool-catalog/${BUILTIN_ID}/revoke`);
    await call('PUT', `/tool-catalog/${BUILTIN_ID}`, { member: 'bin/just' });
    audit.mockClear();
    const res = await call('POST', `/tool-catalog/${BUILTIN_ID}/reset`);
    expect(res.statusCode).toBe(200);
    expect(res.json().statusKept).toBe('REVOKED');
    expect(rows[0]).toMatchObject({
      isCustomized: true,
      member: JUST.member,
      status: 'REVOKED',
    });
    expect(audit.mock.calls[0]?.[0].data.afterJson).toMatchObject({ statusKept: 'REVOKED' });
  });

  it('does not overwrite a revoke that lands between the read and the write', async () => {
    const { audit, call, prisma, rows } = await buildApp();
    prisma.toolCatalogEntry.findUnique.mockImplementationOnce(
      async ({ where }: { where: { id: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        const snapshot = { ...row };
        if (row) {
          row.status = 'REVOKED';
        }
        return snapshot as Row;
      }
    );
    audit.mockClear();
    const res = await call('POST', `/tool-catalog/${BUILTIN_ID}/reset`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TOOL_CHANGED');
    expect(rows[0]?.status).toBe('REVOKED');
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses a row that does not ship built-in', async () => {
    const { call } = await buildApp();
    const res = await call('POST', `/tool-catalog/${CUSTOM_ID}/reset`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_BUILT_IN');
  });
});

describe('POST /tool-catalog validation', () => {
  it('refuses a reserved key', async () => {
    const { call, rows } = await buildApp();
    const res = await call('POST', '/tool-catalog', { ...NEW_TOOL, key: 'git' });
    expect(res.statusCode).toBe(400);
    expect(rows).toHaveLength(2);
  });

  it.each([
    ['userinfo', 'https://u:p@example.com/x.tar.gz'],
    ['query', 'https://example.com/x.tar.gz?token=1'],
  ])('refuses a download url with %s', async (_label, url) => {
    const { call } = await buildApp();
    const res = await call('POST', '/tool-catalog', {
      ...NEW_TOOL,
      archs: { amd64: { sha256: SHA, url } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a member that starts with a dash and notes with a control character', async () => {
    const { call } = await buildApp();
    expect((await call('POST', '/tool-catalog', { ...NEW_TOOL, member: '-P' })).statusCode).toBe(
      400
    );
    expect((await call('POST', '/tool-catalog', { ...NEW_TOOL, notes: 'a\nb' })).statusCode).toBe(
      400
    );
  });
});

describe('DELETE /tool-catalog/:id', () => {
  it('refuses a built-in row — startup would re-create it', async () => {
    const { audit, call, rows } = await buildApp();
    const res = await call('DELETE', `/tool-catalog/${BUILTIN_ID}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BUILT_IN_TOOL');
    expect(rows).toHaveLength(2);
    expect(audit).not.toHaveBeenCalled();
  });

  it('deletes a custom row, audited once', async () => {
    const { audit, call, rows } = await buildApp();
    expect((await call('DELETE', `/tool-catalog/${CUSTOM_ID}`)).statusCode).toBe(200);
    expect(rows).toHaveLength(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('404s on an unknown id', async () => {
    const { call } = await buildApp();
    expect((await call('DELETE', `/tool-catalog/${MISSING_ID}`)).statusCode).toBe(404);
  });
});
