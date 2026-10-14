import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CONFIG_ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString('base64');

import { newSecretColumns } from '../lib/eventEndpoints.js';
import { eventEndpointRoutes } from './eventEndpoints.js';

const TEAM = '55555555-5555-4555-8555-555555555555';
const EP = '66666666-6666-4666-8666-666666666666';
const URL = `/api/v1/teams/${TEAM}/event-endpoints`;
const AUTH = { authorization: 'Bearer fake' };

const state = vi.hoisted(() => ({ platformRole: 'ENGINEER', role: null as string | null }));

function storedRow(over: Record<string, unknown> = {}) {
  return {
    ...newSecretColumns('whsec_stored_secret_value').data,
    createdAt: new Date(),
    enabled: true,
    format: 'json',
    id: EP,
    idPointer: '/id',
    name: 'alerts',
    previousSecretAuthTag: null,
    previousSecretCiphertext: null,
    previousSecretExpiresAt: null,
    previousSecretKeyVersion: null,
    previousSecretLastFour: null,
    previousSecretNonce: null,
    scheme: 'autoswe-v1',
    scopePointer: null,
    signatureEncoding: null,
    signatureHeader: null,
    signaturePrefix: null,
    subjectPointer: null,
    teamId: TEAM,
    timePointer: null,
    typePointer: '/type',
    updatedAt: new Date(),
    ...over,
  };
}

/** Only the selected keys, as Prisma would return them. */
function selected(row: Record<string, unknown>, select?: Record<string, unknown>) {
  return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;
}

async function build(opts: { listening?: number } = {}) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const audit: Array<Record<string, unknown>> = [];
  let row = storedRow();
  const prisma = {
    automation: { count: vi.fn(async () => opts.listening ?? 0) },
    configAuditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audit.push(data);
        return data;
      }),
    },
    eventEndpoint: {
      create: vi.fn(
        async ({
          data,
          select,
        }: {
          data: Record<string, unknown>;
          select: Record<string, unknown>;
        }) => {
          row = storedRow({ ...data, id: EP });
          return selected(row, select);
        }
      ),
      delete: vi.fn(async () => row),
      findFirst: vi.fn(async () => row),
      findMany: vi.fn(async ({ select }: { select: Record<string, unknown> }) => [
        selected(row, select),
      ]),
      update: vi.fn(
        async ({
          data,
          select,
        }: {
          data: Record<string, unknown>;
          select: Record<string, unknown>;
        }) => {
          row = { ...row, ...data };
          return selected(row, select);
        }
      ),
    },
    team: {
      findUnique: vi.fn(async () => ({
        id: TEAM,
        isActive: true,
        memberships: state.role ? [{ role: state.role }] : [],
        name: 'Platform',
        organization: { id: 'org-1', monthlyBudgetUsdCents: null },
        orgId: 'org-1',
      })),
    },
  };
  app.decorate('prisma', prisma as never);
  app.decorate('auth', {
    verifyAccessToken: vi.fn(async () => ({ role: state.platformRole, sub: 'user-1' })),
  } as never);
  await app.register(eventEndpointRoutes, { prefix: '/api/v1/teams' });
  await app.ready();
  return { app, audit, prisma };
}

vi.mock('../plugins/auth.js', async (orig) => {
  const actual = await orig<typeof import('../plugins/auth.js')>();
  return {
    ...actual,
    requireAuth: () => async (request: { user: unknown }) => {
      request.user = { role: state.platformRole, sub: 'user-1' };
    },
  };
});

const CREATE = { format: 'json', name: 'alerts', scheme: 'autoswe-v1' };

beforeEach(() => {
  state.role = 'LEAD';
  state.platformRole = 'ENGINEER';
});

describe('event endpoint management', () => {
  it('hides a team’s endpoints from non-members', async () => {
    state.role = null;
    const { app } = await build();
    expect((await app.inject({ headers: AUTH, method: 'GET', url: URL })).statusCode).toBe(404);
  });

  it('lets members read, never a secret', async () => {
    state.role = 'MEMBER';
    const { app } = await build();
    const res = await app.inject({ headers: AUTH, method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.canManage).toBe(false);
    expect(body.endpoints[0]).toMatchObject({
      path: `/api/v1/webhooks/events/${EP}`,
      secretLastFour: 'alue',
    });
    expect(JSON.stringify(body)).not.toMatch(/Ciphertext|whsec_stored/);
  });

  it('lets only ADMIN and the team’s leads manage', async () => {
    state.role = 'MEMBER';
    const { app } = await build();
    for (const req of [
      { method: 'POST' as const, payload: CREATE, url: URL },
      { method: 'PATCH' as const, payload: { enabled: false }, url: `${URL}/${EP}` },
      { method: 'POST' as const, payload: {}, url: `${URL}/${EP}/secret/rotate` },
      { method: 'DELETE' as const, url: `${URL}/${EP}` },
    ]) {
      expect((await app.inject({ ...req, headers: AUTH })).statusCode).toBe(403);
    }
    state.role = null;
    state.platformRole = 'ADMIN';
    const admin = await build();
    expect(
      (await admin.app.inject({ headers: AUTH, method: 'POST', payload: CREATE, url: URL }))
        .statusCode
    ).toBe(201);
  });

  it('shows a generated secret once, audits without it, and never echoes a given one', async () => {
    const { app, audit } = await build();
    const res = await app.inject({ headers: AUTH, method: 'POST', payload: CREATE, url: URL });
    expect(res.statusCode).toBe(201);
    const { secret } = res.json().data;
    expect(secret).toMatch(/^whsec_/);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(audit[0]).toMatchObject({ action: 'CREATE', entityType: 'EventEndpoint' });

    const given = 'a-vendor-generated-secret';
    const own = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: {
        ...CREATE,
        scheme: 'shared-secret-header',
        secret: given,
        signatureHeader: 'X-Token',
      },
      url: URL,
    });
    expect(own.statusCode).toBe(201);
    expect(own.json().data.secret).toBeUndefined();
    expect(JSON.stringify(audit)).not.toContain(given);
  });

  it('fills a CloudEvents endpoint’s pointers from the attributes', async () => {
    const { app, prisma } = await build();
    await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { ...CREATE, format: 'cloudevents' },
      url: URL,
    });
    expect(prisma.eventEndpoint.create.mock.calls[0]?.[0].data).toMatchObject({
      idPointer: '/id',
      scopePointer: '/source',
      subjectPointer: '/subject',
      typePointer: '/type',
    });
  });

  it('checks each scheme has what it needs and refuses bad pointers', async () => {
    const { app } = await build();
    const post = (payload: Record<string, unknown>) =>
      app.inject({ headers: AUTH, method: 'POST', payload: { ...CREATE, ...payload }, url: URL });
    expect((await post({ scheme: 'hmac-sha256' })).json().error.code).toBe('INVALID_SCHEME');
    expect((await post({ scheme: 'hmac-sha256', signatureHeader: 'Bad Header' })).statusCode).toBe(
      400
    );
    expect((await post({ typePointer: 'type' })).statusCode).toBe(400);
    expect((await post({ secret: 'short' })).statusCode).toBe(400);
    expect((await post({ scheme: 'hmac-sha256', signatureHeader: 'X-Sig' })).statusCode).toBe(201);
  });

  it('rotates a secret, keeping the old one for a day', async () => {
    const { app, audit } = await build();
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: {},
      url: `${URL}/${EP}/secret/rotate`,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.secret).toMatch(/^whsec_/);
    expect(data.previousSecretLastFour).toBe('alue');
    expect(new Date(data.previousSecretExpiresAt).getTime()).toBeGreaterThan(
      Date.now() + 23 * 3600_000
    );
    expect(JSON.stringify(audit)).not.toContain(data.secret);
  });

  it('refuses to remove an endpoint automations still react to', async () => {
    const busy = await build({ listening: 2 });
    const res = await busy.app.inject({ headers: AUTH, method: 'DELETE', url: `${URL}/${EP}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EVENT_ENDPOINT_IN_USE');
    const idle = await build();
    expect(
      (await idle.app.inject({ headers: AUTH, method: 'DELETE', url: `${URL}/${EP}` })).statusCode
    ).toBe(204);
    expect(idle.audit[0]).toMatchObject({ action: 'DELETE' });
    expect(JSON.stringify(idle.audit)).not.toMatch(/Ciphertext/);
  });
});
