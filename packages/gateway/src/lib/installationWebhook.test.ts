import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({ baseUrl: 'https://github.com' }),
}));

import { applyInstallationEvent } from './installationWebhook.js';

type Row = {
  id: string;
  host: string;
  installationId: string;
  accountLogin: string;
  isActive: boolean;
  retiredReason: string | null;
};

const rows: Row[] = [];
const auditCreate = vi.fn();
const update = vi.fn(async ({ data, where }: { data: Partial<Row>; where: { id: string } }) => {
  const row = rows.find((r) => r.id === where.id) as Row;
  Object.assign(row, data);
  return { ...row };
});
const fastify = {
  log: { error: vi.fn() },
  prisma: {
    configAuditLog: { create: auditCreate },
    gitHubHostWebhookSecret: { findMany: async () => [{ host: 'ghe.corp' }] },
    gitHubInstallation: {
      findUnique: async ({
        where: {
          host_installationId: { host, installationId },
        },
      }: {
        where: { host_installationId: { host: string; installationId: string } };
      }) => {
        const row = rows.find((r) => r.host === host && r.installationId === installationId);
        return row ? { ...row } : null;
      },
      update,
    },
  },
} as unknown as FastifyInstance;

let nextId = 0;
const row = (over: Partial<Row>): Row => ({
  accountLogin: 'acme',
  host: '',
  id: `id-${nextId++}`,
  installationId: '7',
  isActive: true,
  retiredReason: null,
  ...over,
});

const payload = (action: string, over: Record<string, unknown> = {}, id = 7) => ({
  action,
  installation: { account: { login: 'acme' }, html_url: 'https://github.com/x', id },
  ...over,
});

beforeEach(() => {
  rows.length = 0;
  vi.clearAllMocks();
});

describe('applyInstallationEvent', () => {
  it('retires an installation on suspend, records why, and audits it as the system', async () => {
    rows.push(row({}));
    const out = await applyInstallationEvent(fastify, 'installation', payload('suspend'), null);
    expect(out).toMatchObject({ changed: ['isActive', 'retiredReason'] });
    expect(rows[0]).toMatchObject({ isActive: false, retiredReason: 'webhook:suspend' });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0]?.[0].data).toMatchObject({
      action: 'UPDATE',
      actorId: null,
      entityId: rows[0]?.id,
      entityType: 'GitHubInstallation',
    });
  });

  it('retires on delete, and unsuspend does not bring a deleted installation back', async () => {
    rows.push(row({}));
    await applyInstallationEvent(fastify, 'installation', payload('deleted'), null);
    expect(rows[0]).toMatchObject({ isActive: false, retiredReason: 'webhook:deleted' });
    await applyInstallationEvent(fastify, 'installation', payload('unsuspend'), null);
    expect(rows[0]?.isActive).toBe(false);
  });

  it('reactivates on unsuspend only what a suspend retired', async () => {
    rows.push(row({ isActive: false, retiredReason: 'webhook:suspend' }));
    await applyInstallationEvent(fastify, 'installation', payload('unsuspend'), null);
    expect(rows[0]).toMatchObject({ isActive: true, retiredReason: null });
  });

  it("never undoes an admin's retirement on unsuspend", async () => {
    rows.push(row({ isActive: false, retiredReason: null }));
    const out = await applyInstallationEvent(fastify, 'installation', payload('unsuspend'), null);
    expect(out).toMatchObject({ changed: [] });
    expect(rows[0]?.isActive).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("does not take over an admin's retirement when GitHub suspends too", async () => {
    rows.push(row({ isActive: false, retiredReason: null }));
    await applyInstallationEvent(fastify, 'installation', payload('suspend'), null);
    // A later unsuspend still leaves it retired, because the reason stays null.
    await applyInstallationEvent(fastify, 'installation', payload('unsuspend'), null);
    expect(rows[0]).toMatchObject({ isActive: false, retiredReason: null });
  });

  it('is a no-op for an installation nobody registered, and never creates one', async () => {
    const out = await applyInstallationEvent(
      fastify,
      'installation',
      payload('deleted', {}, 99),
      null
    );
    expect(out).toEqual({ ignored: true, reason: 'Installation is not registered' });
    expect(update).not.toHaveBeenCalled();
  });

  it('ignores created and new_permissions_accepted', async () => {
    rows.push(row({}));
    for (const action of ['created', 'new_permissions_accepted']) {
      const out = await applyInstallationEvent(fastify, 'installation', payload(action), null);
      expect(out.ignored).toBe(true);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps accountLogin in step on a rename', async () => {
    rows.push(row({}));
    const out = await applyInstallationEvent(
      fastify,
      'installation_target',
      payload('renamed', { account: { login: 'acme-corp' } }),
      null
    );
    expect(out).toMatchObject({ changed: ['accountLogin'] });
    expect(rows[0]?.accountLogin).toBe('acme-corp');
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  describe('host binding', () => {
    it("a per-host secret reaches only that host's installation", async () => {
      rows.push(row({ host: '' }), row({ host: 'ghe.corp' }));
      const body = payload('suspend', {
        installation: { html_url: 'https://ghe.corp/x', id: 7 },
      });
      await applyInstallationEvent(fastify, 'installation', body, 'ghe.corp');
      expect(rows.map((r) => r.isActive)).toEqual([true, false]);
    });

    it('a per-host secret cannot act on an installation whose URL names another host', async () => {
      rows.push(row({ host: 'ghe.corp' }));
      const out = await applyInstallationEvent(
        fastify,
        'installation',
        payload('suspend'), // html_url is github.com
        'ghe.corp'
      );
      expect(out.ignored).toBe(true);
      expect(rows[0]?.isActive).toBe(true);
    });

    it("the instance secret reaches the instance host's installation only", async () => {
      rows.push(row({ host: '' }), row({ host: 'ghe.corp' }));
      await applyInstallationEvent(fastify, 'installation', payload('suspend'), null);
      expect(rows.map((r) => r.isActive)).toEqual([false, true]);
    });

    it("the instance secret cannot touch a host that has its own secret's installation", async () => {
      rows.push(row({ host: 'ghe.corp' }));
      const out = await applyInstallationEvent(
        fastify,
        'installation',
        payload('suspend', { installation: { html_url: 'https://ghe.corp/x', id: 7 } }),
        null
      );
      expect(out.ignored).toBe(true);
      expect(rows[0]?.isActive).toBe(true);
    });

    it('the instance secret ignores an installation on a host that is not the instance', async () => {
      rows.push(row({ host: '' }));
      const out = await applyInstallationEvent(
        fastify,
        'installation',
        payload('suspend', { installation: { html_url: 'https://other.example/x', id: 7 } }),
        null
      );
      expect(out.ignored).toBe(true);
      expect(rows[0]?.isActive).toBe(true);
    });
  });
});
