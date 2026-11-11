import type { PrismaClient } from '@auto-swe/shared';
import { describe, expect, it, vi } from 'vitest';
import { loadEgressReadiness } from './egressReadiness.js';

function fixture(scope = 'GLOBAL') {
  return {
    configSetting: {
      findMany: vi.fn().mockResolvedValue([
        {
          channelId: 'channel',
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
  it.each(['TEAM', 'ORGANIZATION', 'CHANNEL', 'WORKFLOW_TEMPLATE'])(
    'checks only the allowlists involved at %s scope',
    async (scope) => {
      const prisma = fixture(scope);
      const load = () => loadEgressReadiness(prisma as unknown as PrismaClient);
      expect((await load()).ok).toBe(true);
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
      where: { key: 'workspace.egressPolicy' },
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
