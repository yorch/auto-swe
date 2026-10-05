/**
 * The sample repository `db:seed` creates so a fresh install has a connection row to point at.
 * It is a placeholder, not a real repository: readiness must not count it as one, and the seed
 * and the gateway agree on its identity through this constant.
 */
export const SEED_PLACEHOLDER_REPO = {
  organizationName: 'your-org',
  repoName: 'your-repo',
} as const;
