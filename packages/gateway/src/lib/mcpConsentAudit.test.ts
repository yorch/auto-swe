import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { mcpConsentAudit } from './mcpConsentAudit.js';
import { AUTH_BASE_PATH } from './mcpOAuth.js';

describe('mcpConsentAudit', () => {
  it('writes the grant with the request context built from the request, not the async store', async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = {
      configAuditLog: { create },
      oauthConsent: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'consent-1',
          scopes: ['mcp:read'],
          updatedAt: new Date(Date.now() + 60_000),
        }),
      },
    };
    const app = Fastify();
    app.decorate('prisma', prisma as never);
    // The provider owns this endpoint; a stub that answers 200 stands in for it.
    app.post(`${AUTH_BASE_PATH}/oauth2/consent`, async () => ({ ok: true }));
    await app.register(mcpConsentAudit, { getSessionUserId: async () => 'user-1' });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      payload: { accept: true, oauth_query: 'client_id=client-1' },
      remoteAddress: '198.51.100.23',
      url: `${AUTH_BASE_PATH}/oauth2/consent`,
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      actorId: 'user-1',
      context: { ip: '198.51.100.0', requestId: expect.any(String), via: 'session' },
      entityId: 'consent-1',
    });
    await app.close();
  });
});
