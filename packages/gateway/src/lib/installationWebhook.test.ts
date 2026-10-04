import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchAppInstallation, resolveHostCredential } = vi.hoisted(() => ({
  fetchAppInstallation: vi.fn(),
  resolveHostCredential: vi.fn(),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  }),
}));
vi.mock('@auto-swe/shared/lib/githubInstallation', () => ({ fetchAppInstallation }));
vi.mock('@auto-swe/shared/lib/githubHostCredential', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/githubHostCredential')>()),
  resolveHostCredential,
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
const updateMany = vi.fn(async ({ data, where }: { data: Partial<Row>; where: Partial<Row> }) => {
  const row = rows.find((r) => r.id === where.id);
  if (
    !row ||
    row.isActive !== where.isActive ||
    row.retiredReason !== where.retiredReason ||
    row.accountLogin !== where.accountLogin
  ) {
    return { count: 0 };
  }
  Object.assign(row, data);
  return { count: 1 };
});
const fastify = {
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
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
      updateMany,
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
  installation: { html_url: 'https://github.com/x', id },
  ...over,
});
const github = (state: 'active' | 'suspended' | 'deleted', accountLogin: string | null = 'acme') =>
  fetchAppInstallation.mockResolvedValue({ accountLogin, state });

beforeEach(() => {
  rows.length = 0;
  vi.clearAllMocks();
  resolveHostCredential.mockResolvedValue({
    appId: '1',
    appPrivateKey: 'k',
    host: 'ghe.corp',
    token: null,
  });
});

describe('applyInstallationEvent', () => {
  it('retires an installation GitHub reports suspended, and audits it as the system', async () => {
    rows.push(row({}));
    github('suspended');
    const out = await applyInstallationEvent(fastify, 'installation', payload('suspend'), null);
    expect(out).toMatchObject({ changed: ['isActive', 'retiredReason'] });
    expect(rows[0]).toMatchObject({ isActive: false, retiredReason: 'webhook:suspend' });
    expect(auditCreate.mock.calls[0]?.[0].data).toMatchObject({
      action: 'UPDATE',
      actorId: null,
      entityId: rows[0]?.id,
      entityType: 'GitHubInstallation',
    });
  });

  it('retires on a 404 from GitHub', async () => {
    rows.push(row({}));
    github('deleted');
    await applyInstallationEvent(fastify, 'installation', payload('deleted'), null);
    expect(rows[0]).toMatchObject({ isActive: false, retiredReason: 'webhook:deleted' });
  });

  it('a forged deleted or suspend event that GitHub contradicts changes nothing', async () => {
    rows.push(row({}));
    github('active');
    for (const action of ['deleted', 'suspend']) {
      const out = await applyInstallationEvent(fastify, 'installation', payload(action), null);
      expect(out).toMatchObject({ changed: [] });
    }
    expect(rows[0]?.isActive).toBe(true);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('reactivates a webhook retirement once GitHub reports active, and nothing more', async () => {
    rows.push(row({ isActive: false, retiredReason: 'webhook:suspend' }));
    github('active');
    await applyInstallationEvent(fastify, 'installation', payload('unsuspend'), null);
    expect(rows[0]).toMatchObject({ isActive: true, retiredReason: null });
  });

  it("never undoes an admin's retirement, whatever GitHub reports", async () => {
    rows.push(row({ isActive: false, retiredReason: null }));
    github('active');
    const out = await applyInstallationEvent(fastify, 'installation', payload('unsuspend'), null);
    expect(out).toMatchObject({ changed: [] });
    expect(rows[0]?.isActive).toBe(false);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('changes nothing when GitHub cannot be asked', async () => {
    rows.push(row({}));
    fetchAppInstallation.mockRejectedValue(new Error('no App credentials'));
    const out = await applyInstallationEvent(fastify, 'installation', payload('deleted'), null);
    expect(out).toEqual({
      ignored: true,
      reason: 'Could not confirm the installation with GitHub',
    });
    expect(rows[0]?.isActive).toBe(true);
  });

  it('changes nothing for a host with no credentials', async () => {
    rows.push(row({ host: 'ghe.corp' }));
    resolveHostCredential.mockResolvedValue(null);
    const out = await applyInstallationEvent(
      fastify,
      'installation',
      payload('deleted', { installation: { html_url: 'https://ghe.corp/x', id: 7 } }),
      'ghe.corp'
    );
    expect(out.ignored).toBe(true);
    expect(fetchAppInstallation).not.toHaveBeenCalled();
  });

  it('loses to an admin edit that lands between the read and the write', async () => {
    rows.push(row({}));
    fetchAppInstallation.mockImplementationOnce(async () => {
      // The admin retires it by hand while we are asking GitHub.
      (rows[0] as Row).isActive = false;
      return { accountLogin: 'acme', state: 'deleted' };
    });
    const out = await applyInstallationEvent(fastify, 'installation', payload('deleted'), null);
    expect(out).toMatchObject({ changed: [] });
    expect(rows[0]).toMatchObject({ isActive: false, retiredReason: null });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('is a no-op for an installation nobody registered, and never creates one', async () => {
    github('deleted');
    const out = await applyInstallationEvent(
      fastify,
      'installation',
      payload('deleted', {}, 99),
      null
    );
    expect(out).toEqual({ ignored: true, reason: 'Installation is not registered' });
    expect(fetchAppInstallation).not.toHaveBeenCalled();
  });

  it('ignores created and new_permissions_accepted without asking GitHub', async () => {
    rows.push(row({}));
    for (const action of ['created', 'new_permissions_accepted']) {
      const out = await applyInstallationEvent(fastify, 'installation', payload(action), null);
      expect(out.ignored).toBe(true);
    }
    expect(fetchAppInstallation).not.toHaveBeenCalled();
  });

  it('reads a rename from GitHub, not from the payload', async () => {
    rows.push(row({}));
    github('active', 'acme-corp');
    const out = await applyInstallationEvent(
      fastify,
      'installation_target',
      payload('renamed', { account: { login: 'forged' } }),
      null
    );
    expect(out).toMatchObject({ changed: ['accountLogin'] });
    expect(rows[0]?.accountLogin).toBe('acme-corp');
  });

  it('ignores an event that does not name an installation', async () => {
    rows.push(row({}));
    const out = await applyInstallationEvent(
      fastify,
      'installation_target',
      { account: { login: 'x' }, action: 'renamed' },
      null
    );
    expect(out).toEqual({ ignored: true, reason: 'Delivery does not name an installation' });
    expect(fetchAppInstallation).not.toHaveBeenCalled();
  });

  describe('host binding', () => {
    it("a per-host secret reaches only that host's installation", async () => {
      rows.push(row({ host: '' }), row({ host: 'ghe.corp' }));
      github('suspended');
      const body = payload('suspend', { installation: { html_url: 'https://ghe.corp/x', id: 7 } });
      await applyInstallationEvent(fastify, 'installation', body, 'ghe.corp');
      expect(rows.map((r) => r.isActive)).toEqual([true, false]);
    });

    it('a per-host secret cannot act on an installation whose URL names another host', async () => {
      rows.push(row({ host: 'ghe.corp' }));
      github('suspended');
      const out = await applyInstallationEvent(
        fastify,
        'installation',
        payload('suspend'),
        'ghe.corp'
      );
      expect(out.ignored).toBe(true);
      expect(rows[0]?.isActive).toBe(true);
    });

    it("the instance secret reaches the instance host's installation only", async () => {
      rows.push(row({ host: '' }), row({ host: 'ghe.corp' }));
      github('suspended');
      await applyInstallationEvent(fastify, 'installation', payload('suspend'), null);
      expect(rows.map((r) => r.isActive)).toEqual([false, true]);
    });

    it("the instance secret cannot touch a host that has its own secret's installation", async () => {
      rows.push(row({ host: 'ghe.corp' }));
      github('suspended');
      const out = await applyInstallationEvent(
        fastify,
        'installation',
        payload('suspend', { installation: { html_url: 'https://ghe.corp/x', id: 7 } }),
        null
      );
      expect(out.ignored).toBe(true);
      expect(rows[0]?.isActive).toBe(true);
    });

    it('the instance secret ignores a URL on a host that is not the instance', async () => {
      rows.push(row({ host: '' }));
      github('suspended');
      const out = await applyInstallationEvent(
        fastify,
        'installation',
        payload('suspend', { installation: { html_url: 'https://other.example/x', id: 7 } }),
        null
      );
      expect(out.ignored).toBe(true);
      expect(rows[0]?.isActive).toBe(true);
    });

    it('the instance secret ignores a delivery whose enterprise-host header names another host', async () => {
      rows.push(row({ host: '' }));
      github('suspended');
      const out = await applyInstallationEvent(
        fastify,
        'installation',
        payload('suspend', { installation: { id: 7 } }),
        null,
        'other-ghe.example'
      );
      expect(out.ignored).toBe(true);
      expect(rows[0]?.isActive).toBe(true);
    });
  });
});
