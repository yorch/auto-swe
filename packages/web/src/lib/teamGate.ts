import type { TeamParam } from '@/hooks/useTeamParam';

interface GatedQuery {
  error: unknown;
  isError: boolean;
  isFetching: boolean;
  isLoading: boolean;
  refetch: () => unknown;
}

/**
 * The `QueryBoundary` props for a list that waits on the team filter: loading while the slug
 * resolves (the list query is disabled then, and a disabled query is not `isLoading`), and an
 * error with a retry when the team list failed, in place of the all-teams rows.
 */
export function teamGatedBoundary(filter: TeamParam, query: GatedQuery) {
  const teamError = filter.isError;
  return {
    error: teamError ? new Error('team lookup failed') : query.error,
    isError: teamError || query.isError,
    isFetching: query.isFetching,
    isLoading: filter.pending || query.isLoading,
    onRetry: () => (teamError ? filter.retry() : void query.refetch()),
  };
}
