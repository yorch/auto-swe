import type { PrismaClient } from '@auto-swe/shared';
import { describe, expect, it, vi } from 'vitest';
import { loadEgressReadiness } from './egressReadiness.js';

function fixture(scope = 'GLOBAL') {
  return {
    configSetting: {
      findMany: vi.fn().mockResolvedValue([
        {
          channelId: 'channel',
          key: 'workspace.egressPolicy',
          orgId: 'org',
          scope,
          teamId: 'team',
          value: 'restricted',
          workflowTemplateId: 'template',
        },
      ]),
    },
    slackChannel: { findUnique: vi.fn().mockResolvedValue({ orgId: 'org', teamId: 'team' }) },
    team: {
      findMany: vi.fn().mockResolvedValue([
        { egressAllowlist: [], id: 'team', orgId: 'org' },
        { egressAllowlist: ['example.com'], id: 'other', orgId: 'other-org' },
      ]),
      findUnique: vi.fn().mockResolvedValue({ orgId: 'org' }),
    },
    workerEgressCapability: {
      findMany: vi.fn().mockResolvedValue([
        {
          backend: 'docker',
          detail: '',
          egressProxy: false,
          id: 'worker',
          networkLock: true,
          registryProxy: false,
          reportedAt: new Date(),
        },
      ]),
    },
    workflowTemplate: {
      findUnique: vi.fn().mockResolvedValue({ team: { orgId: 'org' }, teamId: 'team' }),
    },
  };
}

describe('scoped egress readiness', () => {
  it('falls back to restricted for an invalid stored GLOBAL policy', async () => {
    const prisma = fixture();
    prisma.configSetting.findMany.mockResolvedValueOnce([
      { key: 'workspace.egressPolicy', scope: 'GLOBAL', value: 'invalid' } as never,
    ]);
    expect((await loadEgressReadiness(prisma as unknown as PrismaClient)).ok).toBe(false);
  });
  it('uses only the changed team organization baseline for team-save warnings', async () => {
    const prisma = fixture();
    prisma.configSetting.findMany.mockResolvedValueOnce([
      {
        key: 'workspace.egressBaselineAllowlist',
        orgId: 'org',
        scope: 'ORGANIZATION',
        value: [],
      } as never,
    ]);
    expect(
      (
        await loadEgressReadiness(prisma as unknown as PrismaClient, undefined, {
          allowlist: [],
          id: 'team',
        })
      ).ok
    ).toBe(true);
  });
  it('does not report the restricted default when GLOBAL explicitly overrides it to open', async () => {
    const prisma = fixture();
    prisma.configSetting.findMany.mockResolvedValueOnce([
      { key: 'workspace.egressPolicy', scope: 'GLOBAL', value: 'open' } as never,
    ]);
    expect((await loadEgressReadiness(prisma as unknown as PrismaClient)).ok).toBe(true);
  });
  it('permits restricted empty effective lists when the organization disables the baseline', async () => {
    const prisma = fixture();
    prisma.team.findMany.mockResolvedValueOnce([{ egressAllowlist: [], id: 'team', orgId: 'org' }]);
    prisma.configSetting.findMany.mockResolvedValueOnce([
      {
        key: 'workspace.egressBaselineAllowlist',
        orgId: 'org',
        scope: 'ORGANIZATION',
        value: [],
      } as never,
    ]);
    expect((await loadEgressReadiness(prisma as unknown as PrismaClient)).ok).toBe(true);
  });
  it.each(['TEAM', 'ORGANIZATION', 'CHANNEL', 'WORKFLOW_TEMPLATE'])(
    'checks only the allowlists involved at %s scope',
    async (scope) => {
      const prisma = fixture(scope);
      const load = () => loadEgressReadiness(prisma as unknown as PrismaClient);
      expect((await load()).ok).toBe(false);
      const result = await loadEgressReadiness(prisma as unknown as PrismaClient, undefined, {
        allowlist: ['example.com'],
        id: 'team',
      });
      expect(result.ok).toBe(false);
      expect(result.warnings[0]).toContain('no egress proxy');
    }
  );
  it('checks the global default and every stored override', async () => {
    const prisma = fixture();
    expect((await loadEgressReadiness(prisma as unknown as PrismaClient)).ok).toBe(false);
    expect(prisma.configSetting.findMany).toHaveBeenCalledWith({
      where: { key: { in: ['workspace.egressPolicy', 'workspace.egressBaselineAllowlist'] } },
    });
    expect(prisma.workerEgressCapability.findMany).toHaveBeenCalledWith({
      where: { reportedAt: { gte: expect.any(Date) } },
    });
  });
  it('warns for a proposed scoped policy before it is stored', async () => {
    const prisma = fixture();
    const result = await loadEgressReadiness(prisma as unknown as PrismaClient, {
      policy: 'blocked',
      selector: { scope: 'GLOBAL' },
    });
    expect(result.warnings).toEqual([]);
  });
});
