import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishOutcome } from './publishOutcome.js';

vi.mock('@auto-swe/shared/db', () => {
  const findFirst = vi.fn();
  return {
    prisma: {
      autonomyDecision: { create: vi.fn().mockResolvedValue({}) },
      autonomyPolicy: {
        findFirst,
        findMany: vi.fn(async (args) => {
          const row = await findFirst(args);
          return row ? [row] : [];
        }),
      },
      workflowRun: {
        findUnique: vi.fn(),
      },
    },
  };
});

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
            isDefault: false,
            name: 'Template override',
            rules: { external_communication: { action: 'auto' } },
            teamId: null,
            templateId: 'tmpl-1',
          });
        }
        return Promise.resolve(null);
      }
    );

    const result = await publishOutcome({ action: 'external_communication', workflowId: 'wf-1' });
    expect(result.decision).toBe('auto');
    expect(result.policyName).toBe('Template override');
    expect(result.approverCount).toBe(1);
  });

  it('falls back to the team default policy', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRun());
    (prisma.autonomyPolicy.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { templateId?: string; teamId?: string | null } }) => {
        if (args.where.teamId && args.where.templateId === null) {
          return Promise.resolve({
            isDefault: true,
            name: 'Team default',
            rules: { external_communication: { action: 'require_approval' } },
            teamId: 'team-1',
            templateId: null,
          });
        }
        return Promise.resolve(null);
      }
    );

    const result = await publishOutcome({ action: 'external_communication', workflowId: 'wf-1' });
    expect(result.decision).toBe('require_approval');
    expect(result.policyName).toBe('Team default');
    expect(result.approverCount).toBe(1);
  });

  it('falls back to the global default policy', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRun());
    (prisma.autonomyPolicy.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { templateId?: string; teamId?: string | null; isDefault?: boolean } }) => {
        if (args.where.teamId === null && args.where.templateId === null && args.where.isDefault) {
          return Promise.resolve({
            isDefault: true,
            name: 'Platform default',
            rules: {
              external_communication: { action: 'require_approval' },
              internal_read: { action: 'auto' },
            },
            teamId: null,
            templateId: null,
          });
        }
        return Promise.resolve(null);
      }
    );

    const result = await publishOutcome({ action: 'external_communication', workflowId: 'wf-1' });
    expect(result.decision).toBe('require_approval');
    expect(result.policyName).toBe('Platform default');
    expect(result.approverCount).toBe(1);
  });

  it('uses the hardcoded fallback when no policy exists', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRun());
    (prisma.autonomyPolicy.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await publishOutcome({ action: 'internal_read', workflowId: 'wf-1' });
    expect(result.decision).toBe('auto');
    expect(result.policyName).toBe('platform fallback');
    expect(result.approverCount).toBe(1);
  });

  it('returns approverCount from the mass_communication fallback rule', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRun());
    (prisma.autonomyPolicy.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await publishOutcome({ action: 'mass_communication', workflowId: 'wf-1' });
    expect(result.decision).toBe('require_approval');
    expect(result.approverCount).toBe(2);
  });

  it('returns the explicit approverCount from a policy rule', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRun());
    (prisma.autonomyPolicy.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      isDefault: false,
      name: 'Custom policy',
      rules: { external_communication: { action: 'require_approval', approverCount: 3 } },
      teamId: null,
      templateId: 'tmpl-1',
    });

    const result = await publishOutcome({ action: 'external_communication', workflowId: 'wf-1' });
    expect(result.approverCount).toBe(3);
  });

  it('defaults invalid approverCount to 1', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRun());
    (prisma.autonomyPolicy.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      isDefault: false,
      name: 'Bad policy',
      rules: { external_communication: { action: 'require_approval', approverCount: 'many' } },
      teamId: null,
      templateId: 'tmpl-1',
    });

    const result = await publishOutcome({ action: 'external_communication', workflowId: 'wf-1' });
    expect(result.approverCount).toBe(1);
  });

  it('defaults unknown risk classes to require_approval', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRun());
    (prisma.autonomyPolicy.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await publishOutcome({ action: 'unknown_risk', workflowId: 'wf-1' });
    expect(result.decision).toBe('require_approval');
    expect(result.approverCount).toBe(1);
  });

  it('fails closed when stored policy JSON is malformed for the requested risk class', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRun());
    (prisma.autonomyPolicy.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      isDefault: false,
      name: 'Corrupt policy',
      rules: 'not-an-object',
      teamId: null,
      templateId: 'tmpl-1',
    });

    const result = await publishOutcome({ action: 'internal_read', workflowId: 'wf-1' });
    expect(result.decision).toBe('require_approval');
    expect(result.approverCount).toBe(1);
  });
});
