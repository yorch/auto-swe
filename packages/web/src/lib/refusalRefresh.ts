import { MutationCache, QueryCache, type QueryClient } from '@tanstack/react-query';
import { PERMISSIONS_KEY } from '@/hooks/useEffectivePermissions';
import { ApiError } from './api';

/** One refetch per window, however many refusals arrive in it. */
export const REFUSAL_REFRESH_WINDOW_MS = 5_000;

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === 'FORBIDDEN';
}

/**
 * A 403 `FORBIDDEN` means the cached permissions may be stale (someone changed the person's role).
 * Returns the `onError` handler for the query and mutation caches: it invalidates the permissions
 * key at most once per window.
 */
export function refreshPermissionsOnRefusal(
  getClient: () => QueryClient | null,
  now: () => number = Date.now
): (error: unknown, query?: { queryKey: readonly unknown[] }) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (error, query) => {
    if (!isForbidden(error)) {
      return;
    }
    // A refused permissions read must not trigger itself.
    if (query?.queryKey[0] === PERMISSIONS_KEY[0] && query.queryKey[1] === PERMISSIONS_KEY[1]) {
      return;
    }
    const t = now();
    if (t - last < REFUSAL_REFRESH_WINDOW_MS) {
      return;
    }
    last = t;
    void getClient()?.invalidateQueries({ queryKey: PERMISSIONS_KEY });
  };
}

export function buildCaches(getClient: () => QueryClient | null) {
  const handle = refreshPermissionsOnRefusal(getClient);
  return {
    mutationCache: new MutationCache({ onError: (error) => handle(error) }),
    queryCache: new QueryCache({ onError: (error, query) => handle(error, query) }),
  };
}
