import { CAMPAIGN_TARGET_STATES, type CampaignCounts } from '@/hooks/useCampaigns';

/** Plain-language names for the recipes the gateway's catalogue knows. */
export const RECIPE_OPTIONS = [
  {
    description: 'The brief is everything the agent has.',
    label: 'No recipe (agent only)',
    value: '',
  },
  {
    description: 'Root package.json with a package-lock.json. Version such as 4.17.21.',
    label: 'npm dependency (npm-dependency@1)',
    value: 'npm-dependency@1',
  },
  {
    description: 'Root go.mod without vendor/ or go.work. Version such as v1.9.0.',
    label: 'Go module (go-module@1)',
    value: 'go-module@1',
  },
] as const;

/** What a campaign changes, for a list row: the recipe and its package, or "agent only". */
export function recipeSummary(
  recipeRef: string | null,
  recipeParams: { packageName: string; targetVersion: string } | null
): string {
  if (!recipeRef) {
    return 'Agent only';
  }
  return recipeParams
    ? `${recipeParams.packageName} → ${recipeParams.targetVersion} (${recipeRef})`
    : recipeRef;
}

const TARGET_STATE_WORDS: Record<keyof CampaignCounts, string> = {
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  NOT_AFFECTED: 'not affected',
  PENDING: 'pending',
  PR_OPENED: 'draft PRs',
  RUNNING: 'running',
  SKIPPED: 'skipped',
};

export function totalTargets(counts: CampaignCounts): number {
  return CAMPAIGN_TARGET_STATES.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
}

/** Targets that reached a final state. */
export function finishedTargets(counts: CampaignCounts): number {
  return totalTargets(counts) - (counts.PENDING ?? 0) - (counts.RUNNING ?? 0);
}

/** "3 draft PRs · 1 failed": the non-zero counts, in a fixed order. */
export function countsText(counts: CampaignCounts): string {
  const parts = CAMPAIGN_TARGET_STATES.filter((s) => (counts[s] ?? 0) > 0).map(
    (s) => `${counts[s]} ${TARGET_STATE_WORDS[s]}`
  );
  return parts.length ? parts.join(' · ') : 'No targets';
}

/** The ticket ID every child of a campaign carries, which is how its pull requests are found. */
export function campaignTicketId(campaignId: string): string {
  return `CAMPAIGN-${campaignId.replaceAll('-', '').slice(0, 12)}`;
}
