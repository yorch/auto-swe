import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ safe: true, warnings: [] })),
}));

import { agentLibraryRoutes } from './agentLibrary.js';

function newMockPrisma() {
  const prisma = {
    agent: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ skillRefs: [] }),
      updateMany: vi.fn(),
    },
    agentSkillRef: {
      create: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    connection: { findUnique: vi.fn() },
    // Empty: a saved spec is checked against the catalog plus the built-in table.
    modelCatalogEntry: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    organization: { findUnique: vi.fn() },
    providerCredential: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    slackChannel: { findUnique: vi.fn() },
    team: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    teamMembership: { findUnique: vi.fn() },
    workflowTemplate: { findUnique: vi.fn() },
  };
  // The service wraps agent + skill-ref writes in an interactive transaction;
  // hand the callback the same fake so the assertions below still see the calls.
  return Object.assign(prisma, {
    // The lineage's advisory lock (CLAUDE.md §7) runs on the transaction client.
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: typeof prisma) => Promise<unknown>)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
  });
}

async function buildAdminApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const mockPrisma = newMockPrisma();
  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(agentLibraryRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, mockPrisma };
}

const AUTH = { authorization: 'Bearer fake' };
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const FROM = 'anthropic/claude-opus-5-5';
const TO = 'openai/gpt-6-luna';
function agent(id = A) {
  return {
    channelId: null,
    credentialId: null as string | null,
    id,
    inheritsModelFrom: null as string | null,
    isActive: true,
    key: id,
    modelSpec: FROM as string | null,
    name: id,
    orgId: null as string | null,
    reasoning: null as string | null,
    runtime: null as string | null,
    scope: 'GLOBAL',
    skillRefs: [],
    teamId: null,
    version: 2,
    workflowTemplateId: null,
  };
}
async function setup(rows = [agent()], role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const { app, mockPrisma: p } = await buildAdminApp(role);
  p.agent.findUnique.mockImplementation(
    async ({ where }) => rows.find((r) => r.id === where.id) ?? null
  );
  p.agent.findFirst.mockImplementation(
    async ({ where }) => rows.find((r) => r.key === where.key) ?? null
  );
  p.agent.create.mockImplementation(async ({ data }) => ({ ...data, id: 'new' }));
  p.agent.findUniqueOrThrow.mockImplementation(async () => {
    const data = p.agent.create.mock.calls.at(-1)?.[0].data;
    return { ...data, id: 'new', skillRefs: [] };
  });
  const post = async (body: Record<string, unknown> = {}, preview = false) =>
    app.inject({
      body: { ids: rows.map((r) => r.id), mode: 'SET', modelSpec: TO, ...body },
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/platform/agent-library/bulk-model${preview ? '/preview' : ''}`,
    });
  return { app, p, post };
}
beforeEach(() => vi.clearAllMocks());

describe('bulk agent model changes', () => {
  it('previews in requested order, dedupes ids, and writes nothing', async () => {
    const { app, p, post } = await setup([agent(), agent(B)]);
    const res = await post({ ids: [B, A, B] }, true);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.changes).toMatchObject([
      { from: FROM, id: B, newVersion: null, status: 'OK', to: TO },
      { from: FROM, id: A, newVersion: null, status: 'OK', to: TO },
    ]);
    expect(p.agent.create).not.toHaveBeenCalled();
    expect(p.configAuditLog.create).not.toHaveBeenCalled();
    await app.close();
  });
  it('cuts and audits a new version for each selected agent', async () => {
    const { app, p, post } = await setup([{ ...agent(), reasoning: 'high' }, agent(B)]);
    const res = await post();
    expect(res.json().data.summary.ok).toBe(2);
    expect(p.agent.create).toHaveBeenCalledTimes(2);
    for (const [args] of p.agent.create.mock.calls) {
      expect(args.data).toMatchObject({ modelSpec: TO, version: 3 });
    }
    expect(p.configAuditLog.create).toHaveBeenCalledTimes(2);
    // The level this operation does not touch is recorded as it really is, not as null.
    expect(p.configAuditLog.create.mock.calls[0][0].data).toMatchObject({
      afterJson: { modelSpec: TO, reasoning: 'high', runtime: null, version: 3 },
      beforeJson: { modelSpec: FROM, reasoning: 'high', runtime: null, version: 2 },
      // The after-state lives on the new version, so that is the row the entry is anchored to.
      entityId: 'new',
    });
    await app.close();
  });
  it('carries per-agent advisories into the plan without blocking the change', async () => {
    const { app, post } = await setup();
    const res = await post({}, true);
    const change = res.json().data.changes[0];
    expect(change.status).toBe('OK');
    expect(change.warnings.join(' ')).toContain(
      "No GLOBAL credential exists for provider 'openai'"
    );
    await app.close();
  });
  it('matches the catch-all for a stored spec that no longer parses', async () => {
    const { app, p, post } = await setup([{ ...agent(), modelSpec: 'not-a-spec' }]);
    const res = await post({ mapping: { '*': TO }, mode: 'REMAP', modelSpec: undefined });
    expect(res.json().data.changes[0]).toMatchObject({ status: 'OK', to: TO });
    expect(p.agent.create).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it.each([
    [{ '*': TO }, 'OK'],
    [{ 'google/other': TO }, 'UNMATCHED'],
    [{ 'Anthropic/Claude-Opus-5-5': TO }, 'OK'],
  ])('remaps using %j', async (mapping, status) => {
    const { app, p, post } = await setup();
    const res = await post({ mapping, mode: 'REMAP', modelSpec: undefined });
    expect(res.json().data.changes[0].status).toBe(status);
    expect(p.agent.create).toHaveBeenCalledTimes(status === 'OK' ? 1 : 0);
    await app.close();
  });
  it('leaves noop and inheriting rows untouched and unaudited', async () => {
    const heir = { ...agent(B), inheritsModelFrom: A, modelSpec: null };
    const { app, p, post } = await setup([agent(), heir]);
    const res = await post({ modelSpec: FROM });
    expect(res.json().data.changes).toMatchObject([
      { status: 'NOOP' },
      { inheritedFrom: A, runtimeChange: null, status: 'INHERITS', to: null },
    ]);
    expect(p.agent.create).not.toHaveBeenCalled();
    expect(p.configAuditLog.create).not.toHaveBeenCalled();
    await app.close();
  });
  it.each([false, true])('requires runtime adaptation opt-in: %s', async (adaptRuntime) => {
    const { app, p, post } = await setup([{ ...agent(), runtime: 'claude-code' }]);
    const res = await post({ adaptRuntime });
    expect(res.json().data.changes[0]).toMatchObject({
      runtimeChange: adaptRuntime ? { from: 'claude-code', to: 'mastra' } : null,
      status: adaptRuntime ? 'OK' : 'BLOCKED',
    });
    if (adaptRuntime) {
      expect(p.agent.create.mock.calls[0][0].data.runtime).toBe('mastra');
    } else {
      expect(p.agent.create).not.toHaveBeenCalled();
      expect(p.configAuditLog.create).not.toHaveBeenCalled();
    }
    await app.close();
  });
  it.each([false, true])(
    'requires credential clearing opt-in: %s',
    async (clearMismatchedCredentials) => {
      const { app, p, post } = await setup([{ ...agent(), credentialId: 'cred' }]);
      p.providerCredential.findUnique.mockResolvedValue({ provider: 'anthropic', scope: 'GLOBAL' });
      const res = await post({ clearMismatchedCredentials });
      expect(res.json().data.changes[0]).toMatchObject({
        credentialCleared: clearMismatchedCredentials,
        status: clearMismatchedCredentials ? 'OK' : 'BLOCKED',
      });
      if (clearMismatchedCredentials) {
        expect(p.agent.create.mock.calls[0][0].data.credentialId).toBeNull();
      } else {
        expect(p.agent.create).not.toHaveBeenCalled();
      }
      await app.close();
    }
  );
  it('uses different REMAP targets and preserves explicit models over inheritance', async () => {
    const other = 'google/gemini-3.8-flash';
    const { app, p, post } = await setup([
      { ...agent(), inheritsModelFrom: B },
      { ...agent(B), modelSpec: other },
    ]);
    const res = await post({
      mapping: { [FROM]: TO, [other]: FROM },
      mode: 'REMAP',
      modelSpec: undefined,
    });
    expect(res.json().data.changes).toMatchObject([
      { status: 'OK', to: TO },
      { status: 'OK', to: FROM },
    ]);
    expect(p.agent.create.mock.calls.map(([args]) => args.data.modelSpec)).toEqual([TO, FROM]);
    await app.close();
  });
  it('reports missing agents without aborting the batch', async () => {
    const { app, p, post } = await setup();
    const res = await post({ ids: [B, A] });
    expect(res.json().data.changes).toMatchObject([
      { blockers: ['Agent not found'], id: B, status: 'ERROR' },
      { id: A, status: 'OK' },
    ]);
    expect(p.agent.create).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('reports a lost version race as a conflict and continues', async () => {
    const { app, p, post } = await setup([agent(), agent(B)]);
    p.agent.create.mockRejectedValueOnce({ code: 'P2002' });
    const res = await post();
    expect(res.json().data.changes).toMatchObject([{ status: 'CONFLICT' }, { status: 'OK' }]);
    expect(p.configAuditLog.create).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('continues after a stale selected version', async () => {
    const rows = [agent(), agent(B)];
    const { app, p, post } = await setup(rows);
    p.agent.findFirst.mockImplementation(async ({ where }) =>
      where.key === A ? { ...rows[0], version: 3 } : rows[1]
    );
    const res = await post();
    expect(res.json().data.changes).toMatchObject([{ status: 'CONFLICT' }, { status: 'OK' }]);
    expect(p.agent.create).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('continues after an unexpected write failure', async () => {
    const { app, p, post } = await setup([agent(), agent(B)]);
    p.agent.create.mockRejectedValueOnce(new Error('write failed'));
    const res = await post();
    expect(res.json().data.changes).toMatchObject([
      { blockers: ['write failed'], status: 'ERROR' },
      { status: 'OK' },
    ]);
    expect(p.configAuditLog.create).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('reports narrower scopes in one shadowing query', async () => {
    const { app, p, post } = await setup();
    p.agent.findMany.mockImplementation(async ({ where }) =>
      where.key
        ? [
            { key: A, scope: 'TEAM' },
            { key: A, scope: 'TEAM' },
            { key: A, scope: 'GLOBAL' },
          ]
        : []
    );
    const res = await post({}, true);
    expect(res.json().data.changes[0].shadowedBy).toEqual(['TEAM']);
    expect(p.agent.findMany.mock.calls.filter(([args]) => args.where.key)).toHaveLength(1);
    await app.close();
  });
  it('refuses to revive a deactivated lineage', async () => {
    const { app, p, post } = await setup([{ ...agent(), isActive: false }]);
    const res = await post();
    expect(res.json().data.changes[0]).toMatchObject({
      blockers: ['This agent is deactivated; reactivate it before changing its model.'],
      status: 'BLOCKED',
    });
    // updateAgent writes isActive: true, so saving here would undo the deactivation.
    expect(p.agent.create).not.toHaveBeenCalled();
    expect(p.configAuditLog.create).not.toHaveBeenCalled();
    await app.close();
  });
  it('carries on when something outside the write throws', async () => {
    const { app, p, post } = await setup([agent(), agent(B)]);
    p.providerCredential.findMany.mockRejectedValueOnce(new Error('advisory query down'));
    const res = await post();
    expect(res.json().data.changes).toMatchObject([
      { blockers: ['advisory query down'], status: 'ERROR' },
      { status: 'OK' },
    ]);
    expect(p.agent.create).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('does not report a committed change as failed when an advisory query breaks', async () => {
    const { app, p, post } = await setup();
    // The catalog answers the pre-write lookup, then breaks once the version is committed —
    // updateAgent computes advisories after its transaction, so a throw there proves nothing
    // about the write.
    p.modelCatalogEntry.findUnique
      .mockResolvedValueOnce(null)
      .mockRejectedValue(new Error('catalog unavailable'));
    const res = await post();
    expect(res.json().data.changes[0]).toMatchObject({ newVersion: 3, status: 'OK' });
    expect(p.agent.create).toHaveBeenCalledTimes(1);
    expect(p.configAuditLog.create).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('counts a narrower row as shadowing only where it can win', async () => {
    const { app, p, post } = await setup([
      { ...agent(), orgId: 'org-1', scope: 'ORGANIZATION' as const },
    ]);
    p.agent.findMany.mockImplementation(async ({ where }) =>
      where.key
        ? [
            { key: A, scope: 'TEAM', teamId: 'team-1' },
            { key: A, scope: 'CHANNEL', teamId: null },
          ]
        : []
    );
    // A channel row wins in its own context whatever it sits above. A team row wins over an
    // organization row for a run in that team, and the resolver tries the team tier first.
    p.team.findMany.mockResolvedValue([{ id: 'team-1', orgId: 'org-1' }]);
    const res = await post({}, true);
    expect(res.json().data.changes[0].shadowedBy).toEqual(['CHANNEL', 'TEAM']);
    await app.close();
  });
  it('ignores a team row belonging to another organization', async () => {
    const { app, p, post } = await setup([
      { ...agent(), orgId: 'org-1', scope: 'ORGANIZATION' as const },
    ]);
    p.agent.findMany.mockImplementation(async ({ where }) =>
      where.key ? [{ key: A, scope: 'TEAM', teamId: 'team-2' }] : []
    );
    // Runs of that team carry its own organization, so they never resolved this row.
    p.team.findMany.mockResolvedValue([]);
    const res = await post({}, true);
    expect(res.json().data.changes[0].shadowedBy).toEqual([]);
    await app.close();
  });
  it('asks about ownership only when an organization row is selected', async () => {
    const { app, p, post } = await setup([agent()]);
    p.agent.findMany.mockImplementation(async ({ where }) =>
      where.key ? [{ key: A, scope: 'TEAM', teamId: 'team-1' }] : []
    );
    const res = await post({}, true);
    // Every run reaches a platform-wide row, so a team row shadows it without any ownership
    // question — and a request naming hundreds of agents must not fan out into lookups for them.
    expect(res.json().data.changes[0].shadowedBy).toEqual(['TEAM']);
    expect(p.team.findMany).not.toHaveBeenCalled();
    expect(p.team.findUnique).not.toHaveBeenCalled();
    await app.close();
  });
  it('asks once about ownership, for the organizations actually selected', async () => {
    const { app, p, post } = await setup([
      { ...agent(), orgId: 'org-1', scope: 'ORGANIZATION' as const },
      { ...agent(B), orgId: 'org-1', scope: 'ORGANIZATION' as const },
    ]);
    p.agent.findMany.mockImplementation(async ({ where }) =>
      where.key
        ? [
            { key: A, scope: 'TEAM', teamId: 'team-1' },
            { key: B, scope: 'TEAM', teamId: 'team-2' },
          ]
        : []
    );
    p.team.findMany.mockResolvedValue([{ id: 'team-1', orgId: 'org-1' }]);
    const res = await post({}, true);
    // One query for both selected rows, and the answer decides each of them: team-1 is inside
    // org-1 so it shadows, while team-2 is not and does not.
    expect(
      res.json().data.changes.map((change: { shadowedBy: string[] }) => change.shadowedBy)
    ).toEqual([['TEAM'], []]);
    expect(p.team.findMany).toHaveBeenCalledTimes(1);
    expect(p.team.findMany.mock.calls[0][0].where).toEqual({ orgId: { in: ['org-1'] } });
    await app.close();
  });
  it('reports a failed read as that agent’s outcome rather than the batch’s', async () => {
    const rows = [agent(), agent(B)];
    const { app, p, post } = await setup(rows);
    p.agent.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === B) {
        throw new Error('read failed');
      }
      return rows.find((r) => r.id === where.id) ?? null;
    });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json().data.changes).toMatchObject([
      { id: A, status: 'OK' },
      // Nothing is known about a row that could not be read — including its scope.
      {
        blockers: ['Could not read this agent: read failed'],
        id: B,
        key: '',
        name: '',
        scope: null,
        status: 'ERROR',
      },
    ]);
    expect(p.agent.create).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('still returns the applied plan when an audit entry cannot be written', async () => {
    const { app, p, post } = await setup();
    p.configAuditLog.create.mockRejectedValueOnce(new Error('audit store down'));
    const res = await post();
    // The change is live; the operator is told the record of it is missing rather than being
    // handed a failed request over something that already happened.
    expect(res.statusCode).toBe(200);
    expect(res.json().data.changes[0]).toMatchObject({ newVersion: 3, status: 'OK' });
    expect(res.json().auditWarnings).toEqual([`${A}: audit store down`]);
    await app.close();
  });
  it.each([true, false])('refuses non-admins (preview=%s)', async (preview) => {
    const { app, post } = await setup([agent()], 'ENGINEER');
    expect((await post({}, preview)).statusCode).toBe(403);
    await app.close();
  });
  it.each([
    { modelSpec: undefined },
    { ids: [] },
    { mode: 'REMAP', modelSpec: undefined },
    { mapping: {}, mode: 'REMAP', modelSpec: undefined },
    { mapping: { bad: TO }, mode: 'REMAP', modelSpec: undefined },
    { mapping: { '*': 'bad' }, mode: 'REMAP', modelSpec: undefined },
    { mapping: { '*': TO } },
    { mapping: { '*': TO }, mode: 'REMAP' },
  ])('refuses invalid body %j', async (body) => {
    const { app, p, post } = await setup();
    expect((await post(body)).statusCode).toBe(400);
    expect(p.agent.create).not.toHaveBeenCalled();
    await app.close();
  });
});
