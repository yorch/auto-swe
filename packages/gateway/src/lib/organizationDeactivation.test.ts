import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '../plugins/auth.js';
import { changeOrganizationActive } from './organizationDeactivation.js';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  defaults: vi.fn(),
}));

vi.mock('./teamJoinRequests.js', () => ({ closeOpenJoinRequests: mocks.close }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({ resolveWorkflowDefaults: mocks.defaults }));

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2';
const ACTOR = { exp: 0, iat: 0, role: 'ADMIN', sub: 'admin-1' } as unknown as JwtPayload;

const ACTIVE = { id: ORG, isActive: true, name: 'Acme', slug: 'acme', trustedInvites: false };
const INACTIVE = { ...ACTIVE, isActive: false };

const order: string[] = [];
const tx = {
  $queryRaw: vi.fn(async (strings: TemplateStringsArray, id: string) => {
    order.push(`raw:${strings.join('?').replace(/\s+/g, ' ').trim()}`);
    return [{ id }];
  }),
  configAuditLog: { create: vi.fn() },
  organization: { findUnique: vi.fn(), update: vi.fn() },
  team: { findUnique: vi.fn() },
};
const fastify = {
  prisma: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) },
} as unknown as FastifyInstance;

const run = (isActive: boolean | undefined, fields = {}) =>
  changeOrganizationActive(fastify, { actor: ACTOR, context: {}, fields, isActive, orgId: ORG });

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  mocks.defaults.mockResolvedValue({ defaultTeamSlug: 'default' });
  mocks.close.mockImplementation(async () => {
    order.push('close');
    return 3;
  });
  tx.team.findUnique.mockResolvedValue({ orgId: OTHER_ORG });
  tx.organization.findUnique.mockResolvedValue(ACTIVE);
  tx.organization.update.mockImplementation(async ({ data }: { data: object }) => {
    order.push('update');
    return { ...ACTIVE, ...data };
  });
});

describe('changeOrganizationActive', () => {
  it('locks the organization row before it reads, writes or closes anything', async () => {
    await run(false);

    expect(order[0]).toBe('raw:SELECT id FROM organizations WHERE id = ?::uuid FOR UPDATE');
    expect(order.slice(1)).toEqual(['update', 'close']);
  });

  it('deactivates, closes the organization’s open requests and audits with the count', async () => {
    const outcome = await run(false);

    expect(outcome).toMatchObject({
      closedJoinRequests: 3,
      ok: true,
      organization: { isActive: false },
    });
    expect(tx.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false }, where: { id: ORG } })
    );
    expect(mocks.close).toHaveBeenCalledWith(
      fastify,
      tx,
      expect.objectContaining({ scope: { orgId: ORG, reason: 'ORGANIZATION_DEACTIVATED' } })
    );
    const row = tx.configAuditLog.create.mock.calls[0]?.[0].data;
    expect(row).toMatchObject({
      action: 'UPDATE',
      actorId: 'admin-1',
      entityId: ORG,
      entityType: 'Organization',
    });
    expect(row.beforeJson).toMatchObject({ isActive: true });
    expect(row.afterJson).toMatchObject({ closedJoinRequests: 3, isActive: false });
  });

  it('refuses the organization that owns the default team, changing and closing nothing', async () => {
    tx.team.findUnique.mockResolvedValue({ orgId: ORG });

    const outcome = await run(false);

    expect(outcome).toMatchObject({ code: 'DEFAULT_ORGANIZATION', ok: false, status: 409 });
    expect(tx.team.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'default' } })
    );
    expect(tx.organization.update).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(tx.configAuditLog.create).not.toHaveBeenCalled();
  });

  it('does not protect the organization slugged default when the default team lives elsewhere', async () => {
    // The default team is in OTHER_ORG, so that organization is the default one, whatever slug
    // this organization carries.
    tx.team.findUnique.mockResolvedValue({ orgId: OTHER_ORG });
    tx.organization.findUnique.mockImplementation(
      async ({ where }: { where: { slug?: string } }) =>
        where.slug === 'default' ? { id: ORG } : ACTIVE
    );

    expect(await run(false)).toMatchObject({ ok: true, organization: { isActive: false } });
  });

  it('refuses the organization slugged default when no default team exists', async () => {
    tx.team.findUnique.mockResolvedValue(null);
    tx.organization.findUnique.mockImplementation(
      async ({ where }: { where: { slug?: string } }) =>
        where.slug === 'default' ? { id: ORG } : ACTIVE
    );

    expect(await run(false)).toMatchObject({ code: 'DEFAULT_ORGANIZATION', ok: false });
    expect(tx.organization.update).not.toHaveBeenCalled();
  });

  it('is a no-op when the value does not change: no write, no second close, no audit', async () => {
    tx.organization.findUnique.mockResolvedValue(INACTIVE);

    const outcome = await run(false);

    expect(outcome).toMatchObject({ closedJoinRequests: 0, ok: true });
    expect(tx.organization.update).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(tx.configAuditLog.create).not.toHaveBeenCalled();
  });

  it('does not re-check the default organization for a deactivation that changes nothing', async () => {
    tx.organization.findUnique.mockResolvedValue(INACTIVE);
    tx.team.findUnique.mockResolvedValue({ orgId: ORG });

    expect(await run(false)).toMatchObject({ ok: true });
  });

  it('reactivates without reopening or closing anything, and audits it', async () => {
    tx.organization.findUnique.mockResolvedValue(INACTIVE);

    const outcome = await run(true);

    expect(outcome).toMatchObject({ closedJoinRequests: 0, ok: true });
    expect(tx.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: true } })
    );
    expect(mocks.close).not.toHaveBeenCalled();
    expect(tx.configAuditLog.create.mock.calls[0]?.[0].data.beforeJson).toMatchObject({
      isActive: false,
    });
    expect(mocks.defaults).not.toHaveBeenCalled();
  });

  it('answers an unknown organization as 404', async () => {
    tx.organization.findUnique.mockResolvedValue(null);

    expect(await run(false)).toMatchObject({ code: 'NOT_FOUND', ok: false, status: 404 });
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('writes the other fields in the same update, and audits only a change', async () => {
    await run(undefined, { name: 'Renamed' });
    expect(tx.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'Renamed' } })
    );
    expect(mocks.close).not.toHaveBeenCalled();

    vi.clearAllMocks();
    tx.organization.findUnique.mockResolvedValue(ACTIVE);
    await run(undefined, {});
    expect(tx.organization.update).not.toHaveBeenCalled();
    expect(tx.configAuditLog.create).not.toHaveBeenCalled();
  });
});
