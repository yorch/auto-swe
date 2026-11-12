import { describe, expect, it } from 'vitest';
import { repositoryOnboardingChecklist } from './repositoryOnboardingChecklist.js';

describe('repository onboarding checklist', () => {
  it('derives an unstarted checklist from empty state', () => {
    expect(repositoryOnboardingChecklist({})).toEqual({
      accessVerified: false,
      dismissed: false,
      firstRunLaunched: false,
      onboardingPrOpened: false,
      onboardingPrUrl: null,
      setupHealthy: true,
      stackScanned: false,
    });
  });
  it('uses successful evidence and filtered relation counts', () => {
    expect(
      repositoryOnboardingChecklist({
        _count: { setupBlockers: 0, workflowRuns: 1 },
        accessVerifiedAt: new Date(),
        detectedStackAt: new Date(),
        onboardingChecklistDismissedAt: new Date(),
        onboardingPrUrl: 'https://github.com/o/r/pull/1',
      })
    ).toEqual({
      accessVerified: true,
      dismissed: true,
      firstRunLaunched: true,
      onboardingPrOpened: true,
      onboardingPrUrl: 'https://github.com/o/r/pull/1',
      setupHealthy: true,
      stackScanned: true,
    });
  });
  it('keeps open setup blockers incomplete', () => {
    expect(
      repositoryOnboardingChecklist({ _count: { setupBlockers: 2, workflowRuns: 0 } }).setupHealthy
    ).toBe(false);
  });
});
