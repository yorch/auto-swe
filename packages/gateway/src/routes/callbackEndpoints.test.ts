import { randomBytes } from 'node:crypto';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callbackEndpointRoutes, runCallbackDeliveryRoutes } from './callbackEndpoints.js';

const TEAM = '11111111-1111-4111-8111-111111111111';
const EP = '22222222-2222-4222-8222-222222222222';
const DELIVERY = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';
const AUTH = { authorization: 'Bearer fake-jwt' };
const BASE = `/api/v1/teams/${TEAM}/callback-endpoints`;

const ORIGINAL_KEY = process.env.CONFIG_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
});
afterAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = ORIGINAL_KEY;
  _resetKeyCacheForTests();
});

function endpointRow(over: Record<string, unknown> = {}) {
  return {
    acceptTemplateWebhookLaunches: false,
    allowPrivateNetwork: false,
    createdAt: new Date('2026-10-01'),
    createdById: 'user-1',
    disabledAt: null,
    events: ['run.completed'],
    id: EP,
    name: 'ci',
    origin: 'https://hooks.example.com',
    pathPrefix: '/hooks',
    previousSigningSecretAuthTag: null,
    previousSigningSecretCiphertext: null,
    previousSigningSecretExpiresAt: null,
    previousSigningSecretKeyVersion: null,
    previousSigningSecretLastFour: null,
    previousSigningSecretNonce: null,
    signingSecretAuthTag: new Uint8Array([1]),
    signingSecretCiphertext: new Uint8Array([2]),
    signingSecretKeyVersion: 1,
    signingSecretLastFour: 'abcd',
    signingSecretNonce: new Uint8Array([3]),
    teamId: TEAM,
    updatedAt: new Date('2026-10-01'),
    ...over,
  };
}

function deliveryRow(over: Record<string, unknown> = {}) {
  return {
    attempts: 3,
    createdAt: new Date('2026-10-01'),
    deadAt: new Date('2026-10-02'),
    deadReason: 'RETRIES_EXHAUSTED',
    deliveredAt: null,
    endpoint: { id: EP, name: 'ci', teamId: TEAM },
    event: 'run.completed',
    id: DELIVERY,
    lastAttemptAt: new Date('2026-10-02'),
    lastError: 'HTTP_STATUS',
    lastStatusCode: 500,
    nextAttemptAt: new Date('2026-10-02'),
    runCallback: { target: 'https://hooks.example.com/hooks/run' },
    status: 'DEAD',
    workflowRunId: RUN,
    ...over,
  };
}

/** `role` is the platform role; `teamRole` the caller's membership in TEAM (null: not a member). */
async function buildApp(role: string, teamRole: string | null) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    callbackEndpoint: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => endpointRow(data)),
      delete: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => endpointRow()),
      findMany: vi.fn(async () => [endpointRow()]),
      findUniqueOrThrow: vi.fn(async () => endpointRow()),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => endpointRow(data)),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    configAuditLog: { create: vi.fn(async () => ({})) },
    outboundDelivery: {
      count: vi.fn(async () => 1),
      findFirst: vi.fn(async () => ({ id: DELIVERY, status: 'DEAD' })),
      findMany: vi.fn(async () => [deliveryRow()]),
      findUniqueOrThrow: vi.fn(async () =>
        deliveryRow({ attempts: 0, deadAt: null, deadReason: null, status: 'PENDING' })
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    teamMembership: {
      findUnique: vi.fn(async () => (teamRole ? { role: teamRole } : null)),
    },
    workflowRun: { findFirst: vi.fn() },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(callbackEndpointRoutes, { prefix: '/api/v1/teams' });
  await app.register(runCallbackDeliveryRoutes, { prefix: '/api/v1/workflow-runs' });
  await app.ready();
  return { app, prisma };
}

const CREATE = { events: ['run.completed'], name: 'ci', origin: 'https://Hooks.Example.com' };

describe('callback endpoint management', () => {
  let admin: Awaited<ReturnType<typeof buildApp>>;
  let lead: Awaited<ReturnType<typeof buildApp>>;
  let engineer: Awaited<ReturnType<typeof buildApp>>;
  let outsider: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    admin = await buildApp('ADMIN', null);
    lead = await buildApp('ENGINEER', 'LEAD');
    engineer = await buildApp('ENGINEER', 'ENGINEER');
    outsider = await buildApp('LEAD', null);
  });
  afterAll(async () => {
    for (const a of [admin, lead, engineer, outsider]) {
      await a.app.close();
    }
  });
  beforeEach(() => {
    for (const a of [admin, lead, engineer, outsider]) {
      vi.clearAllMocks();
      a.prisma.callbackEndpoint.findFirst.mockResolvedValue(endpointRow());
      a.prisma.outboundDelivery.findFirst.mockResolvedValue({ id: DELIVERY, status: 'DEAD' });
    }
  });

  it('refuses every operation to a team ENGINEER and to a non-member', async () => {
    for (const who of [engineer, outsider]) {
      const calls = [
        who.app.inject({ headers: AUTH, method: 'GET', url: BASE }),
        who.app.inject({ headers: AUTH, method: 'POST', payload: CREATE, url: BASE }),
        who.app.inject({
          headers: AUTH,
          method: 'PATCH',
          payload: { name: 'x' },
          url: `${BASE}/${EP}`,
        }),
        who.app.inject({ headers: AUTH, method: 'POST', url: `${BASE}/${EP}/rotate-secret` }),
        who.app.inject({ headers: AUTH, method: 'DELETE', url: `${BASE}/${EP}` }),
        who.app.inject({ headers: AUTH, method: 'GET', url: `${BASE}/${EP}/deliveries` }),
        who.app.inject({
          headers: AUTH,
          method: 'POST',
          url: `${BASE}/${EP}/deliveries/${DELIVERY}/redeliver`,
        }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.statusCode).toBe(403);
      }
      expect(who.prisma.callbackEndpoint.create).not.toHaveBeenCalled();
      expect(who.prisma.outboundDelivery.updateMany).not.toHaveBeenCalled();
    }
  });

  it('lets a team LEAD create one, shows the secret once and audits without it', async () => {
    const res = await lead.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: CREATE,
      url: BASE,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.data.origin).toBe('https://hooks.example.com');
    expect(body.data.pathPrefix).toBe('/');
    expect(JSON.stringify(body.data)).not.toContain(body.secret);
    expect(Object.keys(body.data)).not.toContain('signingSecretCiphertext');
    const audit = JSON.stringify(lead.prisma.configAuditLog.create.mock.calls);
    expect(audit).not.toContain(body.secret);
    expect(audit).not.toContain('Ciphertext');
    expect(audit).toContain('"entityType":"CallbackEndpoint"');
  });

  it('answers BASE_URL_REFUSED for a private origin and refuses http without the opt-in', async () => {
    const priv = await lead.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { ...CREATE, origin: 'https://10.0.0.5' },
      url: BASE,
    });
    expect(priv.statusCode).toBe(400);
    expect(JSON.parse(priv.payload).error.code).toBe('BASE_URL_REFUSED');
    const http = await lead.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { ...CREATE, origin: 'http://hooks.example.com' },
      url: BASE,
    });
    expect(http.statusCode).toBe(400);
    expect(JSON.parse(http.payload).error.code).toBe('INVALID_ORIGIN');
  });

  it('lets only a platform ADMIN opt an endpoint into a private network', async () => {
    const payload = { ...CREATE, allowPrivateNetwork: true, origin: 'http://10.0.0.5:8080' };
    const byLead = await lead.app.inject({ headers: AUTH, method: 'POST', payload, url: BASE });
    expect(byLead.statusCode).toBe(403);
    expect(JSON.parse(byLead.payload).error.code).toBe('PRIVATE_NETWORK_ADMIN_ONLY');
    const viaPatch = await lead.app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { allowPrivateNetwork: true },
      url: `${BASE}/${EP}`,
    });
    expect(viaPatch.statusCode).toBe(403);
    const byAdmin = await admin.app.inject({ headers: AUTH, method: 'POST', payload, url: BASE });
    expect(byAdmin.statusCode).toBe(201);
    // Loopback stays refused whatever the opt-in says.
    const loopback = await admin.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { ...payload, origin: 'http://127.0.0.1:8080' },
      url: BASE,
    });
    expect(JSON.parse(loopback.payload).error.code).toBe('BASE_URL_REFUSED');
  });

  it('lets only a platform ADMIN move an endpoint that may reach a private network', async () => {
    const privateEp = endpointRow({ allowPrivateNetwork: true, origin: 'http://10.0.0.5:8080' });
    for (const payload of [
      { origin: 'http://10.0.3.7:8500' },
      { pathPrefix: '/admin' },
      // Moving it and dropping the opt-in in one write is still a move of an approved destination.
      { allowPrivateNetwork: false, origin: 'https://elsewhere.example.com' },
    ]) {
      lead.prisma.callbackEndpoint.findFirst.mockResolvedValue(privateEp);
      const res = await lead.app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload,
        url: `${BASE}/${EP}`,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe('PRIVATE_NETWORK_ADMIN_ONLY');
    }
    expect(lead.prisma.callbackEndpoint.update).not.toHaveBeenCalled();
    // Renaming it, or only dropping the opt-in, stays open to the team's LEADs.
    lead.prisma.callbackEndpoint.findFirst.mockResolvedValue(privateEp);
    const rename = await lead.app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { allowPrivateNetwork: false, name: 'renamed' },
      url: `${BASE}/${EP}`,
    });
    expect(rename.statusCode).toBe(200);
    admin.prisma.callbackEndpoint.findFirst.mockResolvedValue(privateEp);
    const byAdmin = await admin.app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { origin: 'http://10.0.3.7:8500' },
      url: `${BASE}/${EP}`,
    });
    expect(byAdmin.statusCode).toBe(200);
  });

  it('lets only a platform ADMIN open a private-network endpoint to template webhooks', async () => {
    const privateEp = endpointRow({ allowPrivateNetwork: true, origin: 'http://10.0.0.5:8080' });
    lead.prisma.callbackEndpoint.findFirst.mockResolvedValue(privateEp);
    const byLead = await lead.app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { acceptTemplateWebhookLaunches: true },
      url: `${BASE}/${EP}`,
    });
    expect(byLead.statusCode).toBe(403);
    expect(JSON.parse(byLead.payload).error.code).toBe('PRIVATE_NETWORK_ADMIN_ONLY');
    expect(lead.prisma.callbackEndpoint.update).not.toHaveBeenCalled();
    // On an ordinary endpoint it is the team's call.
    lead.prisma.callbackEndpoint.findFirst.mockResolvedValue(endpointRow());
    const publicEp = await lead.app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { acceptTemplateWebhookLaunches: true },
      url: `${BASE}/${EP}`,
    });
    expect(publicEp.statusCode).toBe(200);
    admin.prisma.callbackEndpoint.findFirst.mockResolvedValue(privateEp);
    const byAdmin = await admin.app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { acceptTemplateWebhookLaunches: true },
      url: `${BASE}/${EP}`,
    });
    expect(byAdmin.statusCode).toBe(200);
  });

  it('refuses a path prefix that is not canonical', async () => {
    const res = await lead.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { ...CREATE, pathPrefix: '/hooks/../admin' },
      url: BASE,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('INVALID_PATH_PREFIX');
  });

  it('rotates the secret, returns it once and audits only that it rotated', async () => {
    const res = await lead.app.inject({
      headers: AUTH,
      method: 'POST',
      url: `${BASE}/${EP}/rotate-secret`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.secret).toMatch(/^whsec_/);
    const where = (lead.prisma.callbackEndpoint.updateMany.mock.calls as unknown[][])[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(where.where).toMatchObject({ id: EP, teamId: TEAM });
    const audit = JSON.stringify(lead.prisma.configAuditLog.create.mock.calls);
    expect(audit).not.toContain(body.secret);
    expect(audit).toContain('secretRotated');
  });

  it('redelivers a DEAD delivery: back to PENDING with a fresh window, audited', async () => {
    const res = await lead.app.inject({
      headers: AUTH,
      method: 'POST',
      url: `${BASE}/${EP}/deliveries/${DELIVERY}/redeliver`,
    });
    expect(res.statusCode).toBe(200);
    const call = (lead.prisma.outboundDelivery.updateMany.mock.calls as unknown[][])[0]?.[0] as {
      data: Record<string, unknown>;
      where: Record<string, unknown>;
    };
    expect(call.data).toMatchObject({ attempts: 0, deadReason: null, status: 'PENDING' });
    expect(call.where).toMatchObject({ endpointId: EP, id: DELIVERY, status: 'DEAD' });
    expect(call.data).toMatchObject({ claimToken: null });
    expect(JSON.stringify(lead.prisma.configAuditLog.create.mock.calls)).toContain(
      'OutboundDelivery'
    );
  });

  it('does not redeliver a delivery that is still being retried', async () => {
    lead.prisma.outboundDelivery.findFirst.mockResolvedValue({ id: DELIVERY, status: 'PENDING' });
    const res = await lead.app.inject({
      headers: AUTH,
      method: 'POST',
      url: `${BASE}/${EP}/deliveries/${DELIVERY}/redeliver`,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error.code).toBe('DELIVERY_PENDING');
    expect(lead.prisma.outboundDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('does not redeliver a delivered row, or to a disabled endpoint', async () => {
    lead.prisma.outboundDelivery.findFirst.mockResolvedValue({ id: DELIVERY, status: 'DELIVERED' });
    const delivered = await lead.app.inject({
      headers: AUTH,
      method: 'POST',
      url: `${BASE}/${EP}/deliveries/${DELIVERY}/redeliver`,
    });
    expect(delivered.statusCode).toBe(409);
    lead.prisma.callbackEndpoint.findFirst.mockResolvedValue(
      endpointRow({ disabledAt: new Date() })
    );
    const disabled = await lead.app.inject({
      headers: AUTH,
      method: 'POST',
      url: `${BASE}/${EP}/deliveries/${DELIVERY}/redeliver`,
    });
    expect(disabled.statusCode).toBe(409);
    expect(lead.prisma.outboundDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('lists deliveries without payloads, bodies or error text', async () => {
    const res = await lead.app.inject({
      headers: AUTH,
      method: 'GET',
      url: `${BASE}/${EP}/deliveries`,
    });
    expect(res.statusCode).toBe(200);
    const [row] = JSON.parse(res.payload).data;
    expect(row).not.toHaveProperty('payload');
    expect(row).toMatchObject({
      canRedeliver: true,
      lastError: 'HTTP_STATUS',
      lastStatusCode: 500,
    });
  });
});

describe('a run’s callback deliveries', () => {
  it('are hidden from someone who cannot see the run', async () => {
    const { app, prisma } = await buildApp('ENGINEER', null);
    prisma.workflowRun.findFirst.mockResolvedValue(null);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${RUN}/callback-deliveries`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('show the target to whoever can see the run, and redeliver only to endpoint managers', async () => {
    const viewer = await buildApp('ENGINEER', 'ENGINEER');
    const manager = await buildApp('ENGINEER', 'LEAD');
    for (const { prisma } of [viewer, manager]) {
      prisma.workflowRun.findFirst.mockResolvedValue({
        id: RUN,
        workflowId: 'wf-1',
        workRequest: {
          callback: {
            endpoint: { teamId: TEAM },
            target: 'https://hooks.example.com/hooks/run',
            workflowId: 'wf-1',
          },
        },
      });
      prisma.outboundDelivery.findMany.mockResolvedValue([deliveryRow()]);
    }
    const url = `/api/v1/workflow-runs/${RUN}/callback-deliveries`;
    const seen = JSON.parse(
      (await viewer.app.inject({ headers: AUTH, method: 'GET', url })).payload
    );
    expect(seen.data.target).toBe('https://hooks.example.com/hooks/run');
    expect(seen.data.deliveries[0].canRedeliver).toBe(false);
    const managed = JSON.parse(
      (await manager.app.inject({ headers: AUTH, method: 'GET', url })).payload
    );
    expect(managed.data.deliveries[0].canRedeliver).toBe(true);
    await viewer.app.close();
    await manager.app.close();
  });

  it('show a viewer outside the endpoint’s team only the origin each went to and how it ended', async () => {
    const outsiderViewer = await buildApp('ENGINEER', null);
    outsiderViewer.prisma.workflowRun.findFirst.mockResolvedValue({
      id: RUN,
      workflowId: 'wf-1',
      workRequest: {
        callback: {
          endpoint: { teamId: TEAM },
          target: 'https://hooks.example.com/hooks/run',
          workflowId: 'wf-1',
        },
      },
    });
    outsiderViewer.prisma.outboundDelivery.findMany.mockResolvedValue([deliveryRow()]);
    const res = await outsiderViewer.app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${RUN}/callback-deliveries`,
    });
    const { data } = JSON.parse(res.payload);
    // A path can be the receiver's secret (a Slack incoming webhook is one): the origin only.
    expect(data.target).toBe('https://hooks.example.com');
    expect(data.deliveries[0]).toEqual({
      createdAt: '2026-10-01T00:00:00.000Z',
      deliveredAt: null,
      event: 'run.completed',
      id: DELIVERY,
      status: 'DEAD',
      target: 'https://hooks.example.com',
    });
    await outsiderViewer.app.close();
  });
});
