import { AGENT_RUN_TEMPLATE_ORIGIN } from '@auto-swe/shared/lib/agentRun';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { codeReviewRoutes } from './codeReview.js';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));
vi.mock('@auto-swe/shared/config', async (original) => ({
  ...(await original<object>()),
  resolveSetting: vi.fn(async () => true),
}));
const guard = vi.hoisted(() => ({ allowed: true, validate: vi.fn() }));
vi.mock('../lib/runConnection.js', () => ({
  validateRunConnection: async (...args: unknown[]) => {
    guard.validate(...args);
    if (!guard.allowed) {
      (args[1] as { status: (n: number) => { send: (body: unknown) => unknown } })
        .status(403)
        .send({ error: { code: 'REPO_ACCESS_DENIED' } });
    }
    return { ok: guard.allowed, source: null };
  },
}));

const SOURCE = '11111111-1111-4111-8111-111111111111';
const REPO = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = '33333333-3333-4333-8333-333333333333';
const PRESET = '44444444-4444-4444-8444-444444444444';
const AUTH = { authorization: 'Bearer fake' };
const launchUrl = `/api/v1/workflow-runs/${SOURCE}/reviews`;
const adminUrl = '/api/v1/platform/review-presets';

async function fixture(role = 'ENGINEER') {
  const source = {
    connectionId: REPO,
    contextSnapshot: { result: { branch: 'auto/change', headSha: 'a'.repeat(40) } },
    id: SOURCE,
    reviewOfRunId: null,
    status: 'SUCCESS',
    steps: [],
    template: { kind: null, origin: null, teamId: null },
    workflowId: 'wf-source',
    workRequest: null,
  };
  const preset = {
    description: '',
    enabled: true,
    id: PRESET,
    name: 'Review',
    onBlocking: 'report',
    systemPrompt: null,
    templateId: TEMPLATE,
  };
  const template = {
    activeVersion: 1,
    id: TEMPLATE,
    kind: 'review',
    name: 'code-review',
    status: 'ACTIVE',
  };
  const ledgers = new Map<string, Record<string, unknown>>();
  let saved: unknown;
  const db = {
    $transaction: vi.fn(),
    activeWorkflow: {
      create: vi.fn(async ({ data }) => {
        ledgers.set(data.temporalWorkflowId, { ...data, id: 'ledger', workRequest: saved });
        return { id: 'ledger' };
      }),
      findUnique: vi.fn(async ({ where }) => ledgers.get(where.temporalWorkflowId) ?? null),
    },
    configAuditLog: { create: vi.fn(async () => ({})) },
    connection: {
      findUnique: vi.fn().mockResolvedValue({
        id: REPO,
        isActive: true,
        team: { orgId: 'org' },
        teamId: 'team',
        type: 'git_repo',
      }),
    },
    pullRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    reviewPreset: {
      create: vi.fn(async ({ data }) => ({ ...preset, ...data })),
      delete: vi.fn(),
      findMany: vi.fn().mockResolvedValue([preset]),
      findUnique: vi.fn().mockResolvedValue(preset),
      update: vi.fn(async ({ data }) => ({ ...preset, ...data })),
    },
    reviewPresetAttachment: {
      create: vi.fn(async ({ data }) => ({ id: PRESET, ...data })),
      delete: vi.fn(),
      findFirst: vi.fn().mockResolvedValue({ id: PRESET, presetId: PRESET, templateId: TEMPLATE }),
    },
    runInput: {
      create: vi.fn(async ({ data }) => {
        saved = data;
        return data;
      }),
    },
    workflowRun: {
      findFirst: vi.fn().mockResolvedValue(source),
      findUnique: vi.fn().mockResolvedValue(source),
    },
    workflowTemplate: {
      findFirst: vi.fn().mockResolvedValue(template),
      findMany: vi.fn().mockResolvedValue([template]),
      findUnique: vi.fn().mockResolvedValue(template),
    },
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const start = vi.fn(async () => undefined);
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', db as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: SOURCE }),
  } as never);
  app.decorate('temporal', { startRunnableWorkflow: start } as never);
  await app.register(codeReviewRoutes, { prefix: '/api/v1' });
  await app.ready();
  return { app, db, preset, source, start, template };
}

beforeEach(() => {
  guard.allowed = true;
  guard.validate.mockClear();
});

describe('review launch route', () => {
  it('requires authentication', async () => {
    const { app, db } = await fixture();
    expect(
      (await app.inject({ method: 'POST', payload: { templateId: TEMPLATE }, url: launchUrl }))
        .statusCode
    ).toBe(401);
    expect(db.workflowRun.findFirst).not.toHaveBeenCalled();
    await app.close();
  });
  it('denies viewers before loading the source', async () => {
    const { app, db } = await fixture('VIEWER');
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { templateId: TEMPLATE },
      url: launchUrl,
    });
    expect(res.statusCode).toBe(403);
    expect(db.workflowRun.findFirst).not.toHaveBeenCalled();
    await app.close();
  });
  it('returns 404 outside the source control filter', async () => {
    const { app, db } = await fixture();
    db.workflowRun.findFirst.mockResolvedValue(null);
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { templateId: TEMPLATE },
      url: launchUrl,
    });
    expect(res.statusCode).toBe(404);
    expect(db.workflowRun.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: SOURCE, OR: expect.any(Array) },
    });
    await app.close();
  });
  it.each(['workflow', 'agent'])(
    'starts a %s source review with ledger rows and caller identity',
    async (kind) => {
      const { app, db, source, start } = await fixture();
      if (kind === 'agent') {
        db.workflowRun.findUnique.mockResolvedValue({
          ...source,
          contextSnapshot: { result: { deliver: 'none', diff: 'stored diff' } },
          template: { kind: null, origin: AGENT_RUN_TEMPLATE_ORIGIN, teamId: null },
        });
      }
      const res = await app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { templateId: TEMPLATE },
        url: launchUrl,
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().data.workflowId).toMatch(/^review-22222222-[a-f0-9]{8}$/);
      expect(res.json().data.runId).toMatch(/^[a-f0-9-]{36}$/);
      expect(db.runInput.create).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledWith(
        res.json().data.workflowId,
        expect.objectContaining({ request: expect.objectContaining({ launchedById: SOURCE }) })
      );
      expect(guard.validate).toHaveBeenCalledOnce();
      await app.close();
    }
  );
  it.each(['non-review', 'disabled', 'empty', 'no-access'])(
    'refuses %s launches without starting Temporal',
    async (kind) => {
      const { app, db, preset, source, template, start } = await fixture();
      if (kind === 'non-review') {
        db.workflowTemplate.findUnique.mockResolvedValue({ ...template, kind: null });
      }
      if (kind === 'disabled') {
        db.reviewPreset.findUnique.mockResolvedValue({ ...preset, enabled: false });
      }
      if (kind === 'empty') {
        db.workflowRun.findUnique.mockResolvedValue({ ...source, contextSnapshot: {} });
      }
      if (kind === 'no-access') {
        guard.allowed = false;
      }
      const res = await app.inject({
        headers: AUTH,
        method: 'POST',
        payload: kind === 'disabled' ? { presetId: PRESET } : { templateId: TEMPLATE },
        url: launchUrl,
      });
      expect(res.statusCode, res.body).toBe(kind === 'no-access' ? 403 : 409);
      expect(start).not.toHaveBeenCalled();
      await app.close();
    }
  );
  it('replays a caller-scoped idempotency key and rejects changed choices', async () => {
    const { app, start } = await fixture();
    const send = (payload: unknown) =>
      app.inject({
        headers: { ...AUTH, 'idempotency-key': 'same-key' },
        method: 'POST',
        payload: payload as object,
        url: launchUrl,
      });
    const first = await send({ templateId: TEMPLATE });
    expect(first.statusCode, first.body).toBe(201);
    const second = await send({ templateId: TEMPLATE });
    expect(second.json()).toEqual(first.json());
    expect(start).toHaveBeenCalledOnce();
    expect((await send({ presetId: PRESET })).statusCode).toBe(409);
    await app.close();
  });
  it('lists minimal enabled presets and launchable review templates', async () => {
    const { app, db } = await fixture();
    const res = await app.inject({ headers: AUTH, url: '/api/v1/review-presets' });
    expect(res.statusCode).toBe(200);
    expect(db.reviewPreset.findMany.mock.calls[0]?.[0]).toMatchObject({
      select: { description: true, id: true, name: true },
      where: { enabled: true },
    });
    expect(res.json().templates).toHaveLength(1);
    await app.close();
  });
});

describe('admin review presets', () => {
  it('denies non-admin writes', async () => {
    const { app, db } = await fixture();
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: { name: 'Review', templateId: TEMPLATE },
          url: adminUrl,
        })
      ).statusCode
    ).toBe(403);
    expect(db.reviewPreset.create).not.toHaveBeenCalled();
    await app.close();
  });
  it('creates, reads, updates, attaches, detaches and deletes with audits', async () => {
    const { app, db } = await fixture('ADMIN');
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
      app.inject({ headers: AUTH, method, url, ...(payload ? { payload } : {}) });
    expect(
      (await call('POST', adminUrl, { name: 'Review', templateId: TEMPLATE })).statusCode
    ).toBe(201);
    expect((await call('GET', adminUrl)).statusCode).toBe(200);
    expect((await call('GET', `${adminUrl}/${PRESET}`)).statusCode).toBe(200);
    expect(
      (await call('PATCH', `${adminUrl}/${PRESET}`, { enabled: false })).json().data.enabled
    ).toBe(false);
    expect(
      (await call('POST', `${adminUrl}/${PRESET}/attachments`, { connectionId: REPO })).statusCode
    ).toBe(201);
    expect(
      (await call('DELETE', `${adminUrl}/${PRESET}/attachments`, { templateId: TEMPLATE }))
        .statusCode
    ).toBe(200);
    expect((await call('DELETE', `${adminUrl}/${PRESET}`)).statusCode).toBe(200);
    expect(db.configAuditLog.create).toHaveBeenCalledTimes(5);
    await app.close();
  });
  it('refuses invalid templates, duplicate names and malformed attachment targets', async () => {
    const { app, db } = await fixture('ADMIN');
    db.workflowTemplate.findUnique.mockResolvedValue({ kind: null });
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: { name: 'X', templateId: TEMPLATE },
          url: adminUrl,
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: { connectionId: REPO, templateId: TEMPLATE },
          url: `${adminUrl}/${PRESET}/attachments`,
        })
      ).statusCode
    ).toBe(400);
    db.workflowTemplate.findUnique.mockResolvedValue({ kind: 'review' });
    db.reviewPreset.create.mockRejectedValue({ code: 'P2002' });
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: { name: 'X', templateId: TEMPLATE },
          url: adminUrl,
        })
      ).statusCode
    ).toBe(409);
    await app.close();
  });
});
