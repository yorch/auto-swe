import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    autonomyPolicy: {
      findMany: vi.fn(async (args) => {
        const row = await mocks.findFirst(args);
        return row ? [row] : [];
      }),
    },
  },
}));

import { FALLBACK_RULES } from '@auto-swe/shared/lib/autonomyPolicy';
import { resolveAutonomyPolicy } from './resolveAutonomyPolicy.js';

const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveAutonomyPolicy', () => {
  it('uses the template-specific policy when present', async () => {
    mocks.findFirst.mockImplementation(
      (args: { where: { templateId?: string; teamId?: string | null; isDefault?: boolean } }) => {
        if (args.where.templateId === TEMPLATE_ID) {
          return Promise.resolve({
            isDefault: false,
            name: 'Template override',
            rules: { external_communication: { action: 'auto' } },
            teamId: null,
            templateId: TEMPLATE_ID,
          });
        }
        return Promise.resolve(null);
      }
    );

    const result = await resolveAutonomyPolicy(TEMPLATE_ID, null, 'external_communication');
    expect(result.name).toBe('Template override');
    expect(result.rules.external_communication).toEqual({ action: 'auto' });
  });

  it('falls back to the team default policy', async () => {
    mocks.findFirst.mockImplementation(
      (args: { where: { templateId?: string; teamId?: string | null; isDefault?: boolean } }) => {
        if (args.where.teamId === TEAM_ID && args.where.isDefault === true) {
          return Promise.resolve({
            isDefault: true,
            name: 'Team default',
            rules: { external_communication: { action: 'require_approval' } },
            teamId: TEAM_ID,
            templateId: null,
          });
        }
        return Promise.resolve(null);
      }
    );

    const result = await resolveAutonomyPolicy(TEMPLATE_ID, TEAM_ID, 'external_communication');
    expect(result.name).toBe('Team default');
    expect(result.rules.external_communication).toEqual({ action: 'require_approval' });
  });

  it('falls back to the global default policy', async () => {
    mocks.findFirst.mockImplementation(
      (args: { where: { teamId?: string | null; isDefault?: boolean } }) => {
        if (args.where.teamId === null && args.where.isDefault === true) {
          return Promise.resolve({
            isDefault: true,
            name: 'Global default',
            rules: { internal_read: { action: 'auto' } },
            teamId: null,
            templateId: null,
          });
        }
        return Promise.resolve(null);
      }
    );

    const result = await resolveAutonomyPolicy(TEMPLATE_ID, null, 'internal_read');
    expect(result.name).toBe('Global default');
    expect(result.rules.internal_read).toEqual({ action: 'auto' });
  });

  it('uses the hard-coded fallback when no policy exists', async () => {
    mocks.findFirst.mockResolvedValue(null);

    const result = await resolveAutonomyPolicy(TEMPLATE_ID, null, 'external_communication');
    expect(result.name).toBe('platform fallback');
    expect(result.rules).toEqual(FALLBACK_RULES);
  });

  it('fails closed for malformed stored JSON', async () => {
    mocks.findFirst.mockImplementation(
      (args: { where: { templateId?: string; teamId?: string | null; isDefault?: boolean } }) => {
        if (args.where.templateId === TEMPLATE_ID) {
          return Promise.resolve({
            isDefault: false,
            name: 'Corrupt template policy',
            rules: 'not-valid-json',
            teamId: null,
            templateId: TEMPLATE_ID,
          });
        }
        return Promise.resolve(null);
      }
    );

    const result = await resolveAutonomyPolicy(TEMPLATE_ID, null, 'internal_read');
    expect(result.rules.internal_read).toEqual({ action: 'require_approval' });
  });

  it('keeps valid rules when stored JSON is well-formed', async () => {
    mocks.findFirst.mockImplementation(
      (args: { where: { templateId?: string; teamId?: string | null; isDefault?: boolean } }) => {
        if (args.where.templateId === TEMPLATE_ID) {
          return Promise.resolve({
            isDefault: false,
            name: 'Valid template policy',
            rules: { internal_read: { action: 'require_approval' } },
            teamId: null,
            templateId: TEMPLATE_ID,
          });
        }
        return Promise.resolve(null);
      }
    );

    const result = await resolveAutonomyPolicy(TEMPLATE_ID, null, 'internal_read');
    expect(result.rules.internal_read).toEqual({ action: 'require_approval' });
  });

  it('fails closed when a scope has multiple matching rows and bounds the query', async () => {
    const duplicate = {
      isDefault: false,
      name: 'Duplicate',
      rules: { internal_read: { action: 'auto' } },
      teamId: null,
      templateId: TEMPLATE_ID,
    };
    const { prisma } = await import('@auto-swe/shared/db');
    vi.mocked(prisma.autonomyPolicy.findMany).mockResolvedValueOnce([
      duplicate,
      duplicate,
    ] as never);

    const result = await resolveAutonomyPolicy(TEMPLATE_ID, null, 'internal_read');

    expect(result.name).toBe('ambiguous policy scope');
    expect(result.rules.internal_read).toEqual({ action: 'require_approval' });
    expect(prisma.autonomyPolicy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 })
    );
  });

  it('skips a template-scoped row that has invalid scope fields', async () => {
    mocks.findFirst.mockImplementation(
      (args: { where: { templateId?: string; teamId?: string | null; isDefault?: boolean } }) => {
        if (args.where.templateId === TEMPLATE_ID) {
          return Promise.resolve({
            isDefault: true, // invalid: template policy should not be default
            name: 'Bad scope',
            rules: { external_communication: { action: 'auto' } },
            teamId: null,
            templateId: TEMPLATE_ID,
          });
        }
        if (args.where.teamId === null && args.where.isDefault === true) {
          return Promise.resolve({
            isDefault: true,
            name: 'Global default',
            rules: { external_communication: { action: 'require_approval' } },
            teamId: null,
            templateId: null,
          });
        }
        return Promise.resolve(null);
      }
    );

    const result = await resolveAutonomyPolicy(TEMPLATE_ID, null, 'external_communication');
    expect(result.name).toBe('Global default');
    expect(result.rules.external_communication).toEqual({ action: 'require_approval' });
  });
});
