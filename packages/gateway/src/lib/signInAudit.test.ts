import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerAuditContext } from './auditContext.js';
import { recordSignInAudit } from './signInAudit.js';

describe('recordSignInAudit', () => {
  it('uses the request address, not the forgeable session address, inside a request', async () => {
    const create = vi.fn(async () => ({}));
    const app = Fastify();
    registerAuditContext(app);
    app.get('/x', async () => {
      await recordSignInAudit({ configAuditLog: { create } } as never, {
        id: 's-1',
        ipAddress: '6.6.6.6',
        userId: 'u-1',
      });
      return {};
    });
    await app.inject({ remoteAddress: '203.0.113.77', url: '/x' });
    expect(create).toHaveBeenCalledWith({
      data: {
        action: 'CREATE',
        actorId: 'u-1',
        afterJson: { event: 'sign_in' },
        context: { ip: '203.0.113.0', requestId: expect.any(String), via: 'session' },
        entityId: 's-1',
        entityType: 'Session',
      },
    });
    await app.close();
  });

  it('falls back to the session row address outside a request', async () => {
    const create = vi.fn(async () => ({}));
    await recordSignInAudit({ configAuditLog: { create } } as never, {
      id: 's-1',
      ipAddress: '203.0.113.77',
      userId: 'u-1',
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ context: { ip: '203.0.113.0', via: 'session' } }),
    });
  });

  it('omits an unknown or unparseable fallback address', async () => {
    const create = vi.fn(async () => ({}));
    await recordSignInAudit({ configAuditLog: { create } } as never, {
      id: 's-1',
      ipAddress: null,
      userId: 'u-1',
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ context: { via: 'session' } }),
    });
  });

  it('swallows a failed write so sign-in is not failed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const create = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(
      recordSignInAudit({ configAuditLog: { create } } as never, { id: 's', userId: 'u' })
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
