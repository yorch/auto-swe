import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ticketRoutes } from './tickets.js';

const lookupTrackerTicket = vi.hoisted(() => vi.fn());
vi.mock('../lib/ticketLookup.js', () => ({ lookupTrackerTicket }));

const CONNECTION_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function build(opts?: { role?: string; connection?: unknown; rateLimit?: boolean }) {
  const findFirst = vi.fn(async () =>
    opts && 'connection' in opts
      ? opts.connection
      : {
          githubApiUrl: null,
          githubUrl: null,
          organizationName: 'acme',
          repoName: 'api',
          team: { orgId: null },
          teamId: 't1',
        }
  );
  const app: FastifyInstance = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('auth', {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: opts?.role ?? 'ENGINEER',
      sub: 'user-1',
    }),
  } as unknown as never);
  app.decorate('prisma', { connection: { findFirst } } as unknown as never);
  if (opts?.rateLimit) {
    app.register(rateLimit, { global: false });
  }
  app.register(ticketRoutes, { prefix: '/api/v1/tickets' });
  return { app, findFirst };
}

function preview(app: FastifyInstance, query: string) {
  return app.inject({
    headers: { authorization: 'Bearer t' },
    method: 'GET',
    url: `/api/v1/tickets/preview?${query}`,
  });
}

describe('GET /api/v1/tickets/preview', () => {
  beforeEach(() => lookupTrackerTicket.mockReset());

  it('returns only the title, status and link of a found ticket', async () => {
    lookupTrackerTicket.mockResolvedValue({
      state: 'found',
      ticket: {
        description: 'SECRET BODY',
        labels: [],
        raw: { comments: ['c'] },
        status: 'In Progress',
        title: 'Health check',
        url: 'https://t.test/PAY-1',
      },
    });
    const { app } = build();
    const res = await preview(app, `ticketId=PAY-1&connectionId=${CONNECTION_ID}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: {
        configured: true,
        found: true,
        status: 'In Progress',
        title: 'Health check',
        url: 'https://t.test/PAY-1',
      },
    });
    expect(res.body).not.toContain('SECRET BODY');
  });

  it('drops a link that is not http(s)', async () => {
    lookupTrackerTicket.mockResolvedValue({
      state: 'found',
      ticket: { status: 's', title: 't', url: 'javascript:alert(1)' },
    });
    const { app } = build();
    const res = await preview(app, `ticketId=PAY-1&connectionId=${CONNECTION_ID}`);
    expect(res.json().data.url).toBeNull();
  });

  it('says not configured when no tracker is set up', async () => {
    lookupTrackerTicket.mockResolvedValue({ state: 'unconfigured' });
    const { app } = build();
    const res = await preview(app, `ticketId=PAY-1&connectionId=${CONNECTION_ID}`);
    expect(res.json().data).toEqual({
      configured: false,
      found: false,
      status: null,
      title: null,
      url: null,
    });
  });

  it('answers found:false for a missing or out-of-scope ticket', async () => {
    lookupTrackerTicket.mockResolvedValue({ state: 'not_found' });
    const { app } = build();
    const res = await preview(app, `ticketId=PAY-1&connectionId=${CONNECTION_ID}`);
    expect(res.json().data).toMatchObject({ configured: true, found: false, title: null });
  });

  it('refuses an invalid ticket id before any lookup', async () => {
    const { app } = build();
    const res = await preview(app, `ticketId=bad%20id!&connectionId=${CONNECTION_ID}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TICKET_ID');
    expect(lookupTrackerTicket).not.toHaveBeenCalled();
  });

  it('answers 404 for a connection the caller cannot reach, with no lookup', async () => {
    const { app } = build({ connection: null });
    const res = await preview(app, `ticketId=PAY-1&connectionId=${CONNECTION_ID}`);
    expect(res.statusCode).toBe(404);
    expect(lookupTrackerTicket).not.toHaveBeenCalled();
  });

  it('scopes a non-admin to reachable connections', async () => {
    lookupTrackerTicket.mockResolvedValue({ state: 'not_found' });
    const { app, findFirst } = build();
    await preview(app, `ticketId=PAY-1&connectionId=${CONNECTION_ID}`);
    const where = (findFirst.mock.calls[0] as unknown as [{ where: { AND: unknown[] } }])[0].where;
    expect(where.AND).toHaveLength(2);
  });

  it('limits the connection lookup to git_repo connections', async () => {
    lookupTrackerTicket.mockResolvedValue({ state: 'not_found' });
    const { app, findFirst } = build();
    await preview(app, `ticketId=PAY-1&connectionId=${CONNECTION_ID}`);
    const where = (findFirst.mock.calls[0] as unknown as [{ where: { AND: unknown[] } }])[0].where;
    expect(where.AND).toContainEqual({ id: CONNECTION_ID, isActive: true, type: 'git_repo' });
  });

  it('answers 503 TRACKER_UNAVAILABLE when the read itself broke', async () => {
    lookupTrackerTicket.mockResolvedValue({ state: 'error' });
    const { app } = build();
    const res = await preview(app, `ticketId=PAY-1&connectionId=${CONNECTION_ID}`);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('TRACKER_UNAVAILABLE');
  });

  it('is rate limited per caller', async () => {
    lookupTrackerTicket.mockResolvedValue({ state: 'not_found' });
    const { app } = build({ rateLimit: true });
    const query = `ticketId=PAY-1&connectionId=${CONNECTION_ID}`;
    for (let i = 0; i < 60; i++) {
      expect((await preview(app, query)).statusCode).toBe(200);
    }
    expect((await preview(app, query)).statusCode).toBe(429);
  });

  it('refuses a missing connection id', async () => {
    const { app } = build();
    expect((await preview(app, 'ticketId=PAY-1')).statusCode).toBe(400);
  });
});
