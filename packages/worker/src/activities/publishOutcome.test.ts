import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishOutcome } from './publishOutcome.js';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    autonomyPolicy: { findFirst: vi.fn() },
    workflowRun: {
      findUnique: vi.fn(),
    },
  },
}));

const { prisma } = await import('@auto-swe/shared/db');

function makeRun(overrides?: { templateTeamId?: string | null }) {
  const teamId =
    overrides?.templateTeamId === null ? null : (overrides?.templateTeamId ?? 'team-1');
  return {
    template: {
      id: 'tmpl-1',
      team: teamId === null ? null : { id: teamId },
      teamId,
    },
    templateId: 'tmpl-1',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('publishOutcome', () => {
  it('throws when the workflow run is not found', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      publishOutcome({ action: 'external_communication', workflowId: 'wf-missing' })
    ).rejects.toThrow('WorkflowRun not found for workflowId wf-missing');
  });

  it('uses the template-specific policy when present', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRun());
    (prisma.autonomyPolicy.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { templateId?: string; teamId?: string | null } }) => {
        if (args.where.templateId) {
          return Promise.resolve({
            name: 'Template override',
            rules: { external_communication: { action: 'auto' } },
          });
        }
        return Promise.resolve(null);
      }
    );

    const result = await publishOutcome({ action: 'external_communication', workflowId: 'wf-1' });
    expect(result.decision).toBe('auto');
    expect(result.policyName).toBe('Template override');
  });

  it('falls back to the team default policy', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRun());
    (prisma.autonomyPolicy.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { templateId?: string; teamId?: string | null } }) => {
        if (args.where.teamId && args.where.templateId === null) {
          return Promise.resolve({
            name: 'Team default',
            rules: { external_communication: { action: 'require_approval' } },
          });
        }
        return Promise.resolve(null);
      }
    );

    const result = await publishOutcome({ action: 'external_communication', workflowId: 'wf-1' });
    expect(result.decision).toBe('require_approval');
    expect(result.policyName).toBe('Team default');
  });

  it('falls back to the global default policy', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRun());
    (prisma.autonomyPolicy.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { templateId?: string; teamId?: string | null; isDefault?: boolean } }) => {
        if (args.where.teamId === null && args.where.templateId === null && args.where.isDefault) {
          return Promise.resolve({
            name: 'Platform default',
            rules: {
              external_communication: { action: 'require_approval' },
              internal_read: { action: 'auto' },
            },
          });
        }
        return Promise.resolve(null);
      }
    );

    const result = await publishOutcome({ action: 'external_communication', workflowId: 'wf-1' });
    expect(result.decision).toBe('require_approval');
    expect(result.policyName).toBe('Platform default');
  });

  it('uses the hardcoded fallback when no policy exists', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRun());
    (prisma.autonomyPolicy.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await publishOutcome({ action: 'internal_read', workflowId: 'wf-1' });
    expect(result.decision).toBe('auto');
    expect(result.policyName).toBe('platform fallback');
  });

  it('defaults unknown risk classes to require_approval', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRun());
    (prisma.autonomyPolicy.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await publishOutcome({ action: 'unknown_risk', workflowId: 'wf-1' });
    expect(result.decision).toBe('require_approval');
  });
});
