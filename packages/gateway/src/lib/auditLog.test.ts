import { describe, expect, it, vi } from 'vitest';
import { writeAuditLog } from './auditLog.js';

const base = {
  action: 'UPDATE',
  actor: { exp: 0, iat: 0, role: 'ADMIN', sub: 'user-1' },
  entityId: 'e-1',
  entityType: 'Team',
} as const;

describe('writeAuditLog', () => {
  it('omits the context key when no request store exists', async () => {
    const create = vi.fn(async () => ({}));
    await writeAuditLog({ prisma: { configAuditLog: { create } } } as never, base as never);
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect('context' in data).toBe(false);
  });

  it('writes an explicit context', async () => {
    const create = vi.fn(async () => ({}));
    await writeAuditLog(
      { prisma: {} } as never,
      { ...base, client: { configAuditLog: { create } }, context: { via: 'jwt' } } as never
    );
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ context: { via: 'jwt' } }),
    });
  });
});
