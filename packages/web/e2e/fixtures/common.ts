import type { RepositorySummary, TeamSummary } from '@auto-swe/shared/types/api';

/** The instant every shot is taken at (`page.clock`); fixture times sit just before it. */
export const NOW = new Date('2026-10-17T09:00:00.000Z');

/** An ISO timestamp `minutes` before {@link NOW}. */
export function ago(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

/** An ISO timestamp `minutes` after {@link NOW}. */
export function ahead(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

/** The `{ data, meta }` envelope every paginated gateway list answers. */
export function page<T>(data: T[], total = data.length) {
  return { data, meta: { limit: 50, offset: 0, total } };
}

export const TEAMS: TeamSummary[] = [
  {
    _count: { memberships: 8, repositories: 3 },
    defaultPersonaPrompt: null,
    description: 'Payments and billing services',
    id: 'team-payments',
    name: 'Payments',
    slug: 'payments',
  },
  {
    _count: { memberships: 5, repositories: 2 },
    defaultPersonaPrompt: null,
    description: 'Build, deploy and developer tooling',
    id: 'team-platform',
    name: 'Platform Eng',
    slug: 'platform-eng',
  },
];

const repo = (
  id: string,
  organizationName: string,
  repoName: string,
  language: string,
  team: TeamSummary
): RepositorySummary => ({
  _count: { activeWorkflows: 1 },
  config: null,
  consolidationEnabled: true,
  defaultBranch: 'main',
  description: null,
  executorImage: null,
  gateCommands: null,
  id,
  isActive: true,
  language,
  name: null,
  organizationName,
  repoName,
  shares: [],
  team: { id: team.id, name: team.name, slug: team.slug },
  type: 'git_repo',
});

export const REPOSITORIES: RepositorySummary[] = [
  repo('repo-payments-api', 'acme', 'payments-api', 'TypeScript', TEAMS[0]),
  repo('repo-ledger', 'acme', 'ledger', 'Go', TEAMS[0]),
  repo('repo-deploy-tools', 'acme', 'deploy-tools', 'Python', TEAMS[1]),
];
