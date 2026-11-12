import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ info: vi.fn(), run: vi.fn(), version: vi.fn() }));
vi.mock('@temporalio/activity', () => ({ activityInfo: m.info }));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    workflowRun: { findUnique: m.run },
    workflowTemplateVersion: { findUnique: m.version },
  },
}));

import { REPO_ONBOARDING_SPEC } from '@auto-swe/shared/workflow';
import { isOnboardingDraftAgent } from './onboardingEgress.js';

const run = {
  template: { kind: null, name: 'repo-onboarding', origin: 'swe-starter', teamId: null },
  templateId: 'template-1',
  templateVersion: 3,
  temporalRunId: 'execution-1',
};
beforeEach(() => {
  vi.resetAllMocks();
  m.info.mockReturnValue({ workflowExecution: { runId: 'execution-1', workflowId: 'wf-1' } });
  m.run.mockResolvedValue(run);
  m.version.mockResolvedValue({ createdBy: null, generatedBy: null });
});
describe('onboarding draft authority', () => {
  it('accepts the registered builtin with seeded global version provenance', async () => {
    const builtin = REPO_ONBOARDING_SPEC;
    expect(builtin.nodes.draft).toMatchObject({
      agentRef: 'repo-onboarder',
      workspace: true,
    });
    m.run.mockResolvedValue({
      ...run,
      template: { ...run.template, name: builtin.name },
      templateVersion: 1,
    });
    m.version.mockResolvedValue({ createdBy: null, generatedBy: null });
    expect(await isOnboardingDraftAgent('repo-onboarder')).toBe(true);
    expect(m.version).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { templateId_version: { templateId: 'template-1', version: 1 } },
      })
    );
  });
  it('verifies this exact execution and its seeded template version', async () => {
    expect(await isOnboardingDraftAgent('repo-onboarder')).toBe(true);
    expect(m.run).toHaveBeenCalledWith(expect.objectContaining({ where: { workflowId: 'wf-1' } }));
    expect(m.version).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { templateId_version: { templateId: 'template-1', version: 3 } },
      })
    );
  });
  it('does not query provenance for another agent', async () => {
    expect(await isOnboardingDraftAgent('reviewer')).toBe(false);
    expect(m.run).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...run, temporalRunId: 'stale' },
    { ...run, template: { ...run.template, name: 'custom' } },
    { ...run, template: { ...run.template, teamId: 'team-1' } },
    { ...run, template: { ...run.template, origin: null } },
  ])('refuses an unverified or non-builtin run: %j', async (row) => {
    m.run.mockResolvedValue(row);
    expect(await isOnboardingDraftAgent('repo-onboarder')).toBe(false);
    expect(m.version).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { createdBy: 'user-1', generatedBy: null },
    { createdBy: null, generatedBy: 'workflow-author' },
  ])('refuses an absent or authored version: %j', async (version) => {
    m.version.mockResolvedValue(version);
    expect(await isOnboardingDraftAgent('repo-onboarder')).toBe(false);
  });
  it('refuses activity calls without a verified workflow execution', async () => {
    m.info.mockImplementation(() => {
      throw new Error('outside activity');
    });
    expect(await isOnboardingDraftAgent('repo-onboarder')).toBe(false);
    expect(m.run).not.toHaveBeenCalled();
  });
  it('propagates database errors instead of granting on incomplete evidence', async () => {
    m.run.mockRejectedValue(new Error('unavailable'));
    await expect(isOnboardingDraftAgent('repo-onboarder')).rejects.toThrow('unavailable');
  });
});
