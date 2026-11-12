import type { RepositoryOnboardingChecklist } from '@auto-swe/shared/types/api';

export const onboardingChecklistCounts = {
  activeWorkflows: true,
  setupBlockers: { where: { resolvedAt: null } },
  workflowRuns: true,
} as const;

export function repositoryOnboardingChecklist(repo: {
  accessVerifiedAt?: Date | null;
  detectedStackAt?: Date | null;
  onboardingPrUrl?: string | null;
  onboardingChecklistDismissedAt?: Date | null;
  _count?: { setupBlockers?: number; workflowRuns?: number };
}): RepositoryOnboardingChecklist {
  return {
    accessVerified: repo.accessVerifiedAt != null,
    dismissed: repo.onboardingChecklistDismissedAt != null,
    firstRunLaunched: (repo._count?.workflowRuns ?? 0) > 0,
    onboardingPrOpened: Boolean(repo.onboardingPrUrl),
    onboardingPrUrl: repo.onboardingPrUrl ?? null,
    setupHealthy: (repo._count?.setupBlockers ?? 0) === 0,
    stackScanned: repo.detectedStackAt != null,
  };
}
