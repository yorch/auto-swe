import { describe, expect, it, vi } from 'vitest';
import {
  hasTenantPredicate,
  isUnscoped,
  runUnscoped,
  TENANT_SCOPED_MODELS,
  tenantGuardExtension,
  UnscopedTenantQueryError,
} from './tenantGuard.js';

/** Invoke the extension's interceptor the way Prisma's `$extends` would. */
function intercept(
  ext: ReturnType<typeof tenantGuardExtension>,
  call: { model: string; operation: string; args?: unknown }
) {
  const query = vi.fn(async () => 'result');
  const run = ext.query.$allModels.$allOperations({
    args: call.args ?? {},
    model: call.model,
    operation: call.operation,
    query,
  });
  return { query, run };
}

describe('hasTenantPredicate', () => {
  it.each([
    ['teamId', { teamId: 't1' }],
    ['orgId', { orgId: 'o1' }],
    ['a team relation', { team: { memberships: { some: { userId: 'u1' } } } }],
    ['a memberships relation', { memberships: { some: { userId: 'u1' } } }],
    ['nested inside AND', { AND: [{ isActive: true }, { teamId: 't1' }] }],
    ['nested inside NOT', { NOT: { teamId: 't1' } }],
    // How the lessons routes scope: tenancy reached through a relation.
    ['through a relation', { repository: { team: { memberships: { some: { userId: 'u' } } } } }],
    ['through a list filter', { cases: { some: { dataset: { teamId: 't1' } } } }],
  ])('accepts %s', (_label, where) => {
    expect(hasTenantPredicate(where)).toBe(true);
  });

  it('accepts the global-plus-mine OR shape the gateway uses', () => {
    // `teamId: null` rows are global-by-design; the OR still bounds the query.
    expect(
      hasTenantPredicate({ OR: [{ teamId: null }, { team: { memberships: { some: {} } } }] })
    ).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['an empty where', {}],
    ['an unrelated filter', { status: 'ACTIVE' }],
    ['an id lookup', { id: 'abc' }],
    ['an OR with no tenant branch', { OR: [{ status: 'A' }, { status: 'B' }] }],
  ])('rejects %s', (_label, where) => {
    expect(hasTenantPredicate(where)).toBe(false);
  });
});

describe('tenantGuardExtension', () => {
  it('blocks an unfiltered findMany on a tenant-scoped model', async () => {
    const ext = tenantGuardExtension({ mode: 'throw' });
    const { query, run } = intercept(ext, { model: 'Connection', operation: 'findMany' });

    await expect(run).rejects.toBeInstanceOf(UnscopedTenantQueryError);
    // Never reached the database.
    expect(query).not.toHaveBeenCalled();
  });

  it('names the model and the fix in the error', async () => {
    const ext = tenantGuardExtension({ mode: 'throw' });
    const { run } = intercept(ext, { model: 'Skill', operation: 'findMany' });
    await expect(run).rejects.toThrow(/Skill\.findMany\(\).*runUnscoped/s);
  });

  it('allows a filtered query through', async () => {
    const ext = tenantGuardExtension({ mode: 'throw' });
    const { query, run } = intercept(ext, {
      args: { where: { teamId: 't1' } },
      model: 'Connection',
      operation: 'findMany',
    });

    await expect(run).resolves.toBe('result');
    expect(query).toHaveBeenCalledOnce();
  });

  it('ignores models that carry no tenancy', async () => {
    const ext = tenantGuardExtension({ mode: 'throw' });
    const { run } = intercept(ext, { model: 'ActiveWorkflow', operation: 'findMany' });
    await expect(run).resolves.toBe('result');
  });

  it('ignores single-row lookups, which are out of scope by design', async () => {
    const ext = tenantGuardExtension({ mode: 'throw' });
    for (const operation of ['findUnique', 'findFirst', 'create', 'update']) {
      const { run } = intercept(ext, { model: 'Connection', operation });
      await expect(run, operation).resolves.toBe('result');
    }
  });

  it.each([
    'deleteMany',
    'updateMany',
    'count',
    'aggregate',
    'groupBy',
  ])('guards %s, not just findMany', async (operation) => {
    const ext = tenantGuardExtension({ mode: 'throw' });
    const { run } = intercept(ext, { model: 'MemoryItem', operation });
    await expect(run).rejects.toBeInstanceOf(UnscopedTenantQueryError);
  });

  it('lets an explicitly unscoped call through', async () => {
    const ext = tenantGuardExtension({ mode: 'throw' });
    const result = await runUnscoped('admin listing', () => {
      const { run } = intercept(ext, { model: 'Connection', operation: 'findMany' });
      return run;
    });
    expect(result).toBe('result');
  });

  it('keeps the unscoped marker across an await', async () => {
    // AsyncLocalStorage, not a flag — a plain boolean would leak into whatever
    // else was running concurrently.
    await runUnscoped('admin listing', async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(isUnscoped()).toBe(true);
    });
    expect(isUnscoped()).toBe(false);
  });

  it('warns instead of throwing in warn mode', async () => {
    const onViolation = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ext = tenantGuardExtension({ mode: 'warn', onViolation });

    const { query, run } = intercept(ext, { model: 'Connection', operation: 'findMany' });

    await expect(run).resolves.toBe('result');
    expect(onViolation).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('throws by default outside production — every call site is triaged, so a new one is a bug', async () => {
    const prevStrict = process.env.TENANT_GUARD_STRICT;
    const prevEnv = process.env.NODE_ENV;
    try {
      delete process.env.TENANT_GUARD_STRICT;
      process.env.NODE_ENV = 'test';
      const ext = tenantGuardExtension();
      await expect(
        intercept(ext, { model: 'Connection', operation: 'findMany' }).run
      ).rejects.toBeInstanceOf(UnscopedTenantQueryError);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevStrict !== undefined) {
        process.env.TENANT_GUARD_STRICT = prevStrict;
      }
    }
  });

  it('warns in production, so a false positive does not take the API down', async () => {
    const prevStrict = process.env.TENANT_GUARD_STRICT;
    const prevEnv = process.env.NODE_ENV;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      delete process.env.TENANT_GUARD_STRICT;
      process.env.NODE_ENV = 'production';
      const ext = tenantGuardExtension();
      await expect(
        intercept(ext, { model: 'Connection', operation: 'findMany' }).run
      ).resolves.toBe('result');
    } finally {
      warn.mockRestore();
      process.env.NODE_ENV = prevEnv;
      if (prevStrict !== undefined) {
        process.env.TENANT_GUARD_STRICT = prevStrict;
      }
    }
  });

  it('throws in production too when TENANT_GUARD_STRICT=1', async () => {
    const prevStrict = process.env.TENANT_GUARD_STRICT;
    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.TENANT_GUARD_STRICT = '1';
      process.env.NODE_ENV = 'production';
      const ext = tenantGuardExtension();
      await expect(
        intercept(ext, { model: 'Connection', operation: 'findMany' }).run
      ).rejects.toBeInstanceOf(UnscopedTenantQueryError);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevStrict === undefined) {
        delete process.env.TENANT_GUARD_STRICT;
      } else {
        process.env.TENANT_GUARD_STRICT = prevStrict;
      }
    }
  });
});

describe('TENANT_SCOPED_MODELS', () => {
  it('matches the models that carry teamId/orgId in the schema', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const schema = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../prisma/schema.prisma'),
      'utf8'
    );

    const fromSchema = new Set<string>();
    let model: string | null = null;
    let columns: string[] = [];
    for (const line of schema.split('\n')) {
      const start = /^model (\w+) \{/.exec(line);
      if (start) {
        model = start[1];
        columns = [];
        continue;
      }
      if (line.trim() === '}') {
        if (model && columns.some((c) => c === 'teamId' || c === 'orgId')) {
          fromSchema.add(model);
        }
        model = null;
        continue;
      }
      const col = /^\s*(\w+)\s+\S/.exec(line);
      if (col && model) {
        columns.push(col[1]);
      }
    }

    // A new tenant-scoped model that nobody adds here is unguarded, and the
    // omission is invisible — same failure mode as the docs allowlist.
    expect([...TENANT_SCOPED_MODELS].sort()).toEqual([...fromSchema].sort());
  });
});
