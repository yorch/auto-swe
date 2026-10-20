import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  auditContextData,
  currentAuditContext,
  registerAuditContext,
  truncateIp,
} from './auditContext.js';
import { writeAuditLog } from './auditLog.js';

describe('truncateIp', () => {
  it.each([
    ['203.0.113.77', '203.0.113.0'],
    ['::ffff:198.51.100.23', '198.51.100.0'],
    ['2001:db8:abcd:1234:5678::1', '2001:db8:abcd::'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8:0::'],
    ['::1', '0:0:0::'],
    ['fe80::1%eth0', 'fe80:0:0::'],
    ['::ffff:c633:6417', '0:0:0::'],
  ])('truncates %s to %s', (raw, expected) => {
    expect(truncateIp(raw)).toBe(expected);
  });

  it.each([[''], [undefined], [null], ['not-an-ip'], ['999.1.1.1'], ['1:2:3']])(
    'omits %s',
    (raw) => {
      expect(truncateIp(raw as never)).toBeUndefined();
    }
  );
});

describe('audit context store', () => {
  it('is absent outside a request, so the key is omitted', () => {
    expect(currentAuditContext()).toBeUndefined();
    expect(auditContextData()).toEqual({});
  });

  it('reaches a handler that awaits after a JSON body, and reads via from a route-level preHandler', async () => {
    const app = Fastify({ trustProxy: true });
    registerAuditContext(app);
    app.post(
      '/x',
      {
        // Authenticates in the route's own preHandler, which runs AFTER the global hook.
        preHandler: async (request) => {
          request.authMethod = 'pat';
        },
      },
      async (request) => {
        await new Promise((r) => setTimeout(r, 5));
        return { body: request.body, context: currentAuditContext() };
      }
    );
    const res = await app.inject({
      headers: { 'x-forwarded-for': '203.0.113.77' },
      method: 'POST',
      payload: { hello: 'world' },
      url: '/x',
    });
    const json = res.json();
    expect(json.body).toEqual({ hello: 'world' });
    expect(json.context).toEqual({ ip: '203.0.113.0', requestId: expect.any(String), via: 'pat' });
    expect(currentAuditContext()).toBeUndefined();
    await app.close();
  });

  it('writes via from auth that ran in the route preHandler, after the global hook', async () => {
    const create = vi.fn(async () => ({}));
    const app = Fastify();
    registerAuditContext(app);
    app.put(
      '/late',
      {
        preHandler: async (request) => {
          request.authMethod = 'jwt';
        },
      },
      async () => {
        await writeAuditLog({ prisma: { configAuditLog: { create } } } as never, {
          action: 'UPDATE',
          actor: null,
          entityId: 'e',
          entityType: 'Team',
        });
        return {};
      }
    );
    await app.inject({ method: 'PUT', payload: { a: 1 }, url: '/late' });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ context: expect.objectContaining({ via: 'jwt' }) }),
    });
    await app.close();
  });

  it('is visible inside a prisma.$transaction callback', async () => {
    const create = vi.fn(async () => ({}));
    const tx = { configAuditLog: { create } };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
        await Promise.resolve();
        return fn(tx);
      },
    };
    const app = Fastify();
    registerAuditContext(app);
    app.get(
      '/tx',
      {
        preHandler: async (request) => {
          request.authMethod = 'pat';
        },
      },
      async () => {
        await prisma.$transaction(async (t) => {
          await writeAuditLog({ prisma } as never, {
            action: 'UPDATE',
            actor: null,
            client: t as never,
            entityId: 'e',
            entityType: 'Team',
          });
        });
        return {};
      }
    );
    await app.inject({ url: '/tx' });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ context: expect.objectContaining({ via: 'pat' }) }),
    });
    await app.close();
  });

  it('omits the address for an assistant call and records its conversation', async () => {
    const app = Fastify();
    registerAuditContext(app);
    app.get(
      '/a',
      {
        preHandler: async (request) => {
          request.authMethod = 'assistant';
          request.assistant = { access: 'confirm', actionId: 'act-1', conversationId: 'conv-1' };
        },
      },
      async () => currentAuditContext()
    );
    const res = await app.inject({ url: '/a' });
    expect(res.json()).toEqual({
      actionId: 'act-1',
      conversationId: 'conv-1',
      requestId: expect.any(String),
      via: 'assistant',
    });
    await app.close();
  });

  it('keeps the address and names the client for an MCP call', async () => {
    const app = Fastify();
    registerAuditContext(app);
    app.get(
      '/m',
      {
        preHandler: async (request) => {
          request.authMethod = 'mcp';
          request.mcpBridge = { clientId: 'client-1', consentId: 'c', scopes: [] };
        },
      },
      async () => currentAuditContext()
    );
    const res = await app.inject({ remoteAddress: '198.51.100.9', url: '/m' });
    expect(res.json()).toMatchObject({ ip: '198.51.100.0', mcpClientId: 'client-1', via: 'mcp' });
    await app.close();
  });

  it('records the service principal', async () => {
    const app = Fastify();
    registerAuditContext(app);
    app.get(
      '/s',
      {
        preHandler: async (request) => {
          request.authMethod = 'service';
          request.principal = { servicePrincipalId: 'sp-1' } as never;
        },
      },
      async () => currentAuditContext()
    );
    const res = await app.inject({ url: '/s' });
    expect(res.json()).toMatchObject({ servicePrincipalId: 'sp-1', via: 'service' });
    await app.close();
  });
});
