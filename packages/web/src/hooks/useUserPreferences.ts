'use client';

import {
  RUN_DETAIL_LAYOUTS,
  type RunDetailLayout,
  type UserPreferences,
} from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

function isRunDetailLayout(value: unknown): value is RunDetailLayout {
  return (RUN_DETAIL_LAYOUTS as readonly unknown[]).includes(value);
}

interface PreferencesResponse {
  preferences: UserPreferences;
}

const QUERY_KEY = ['me-preferences'] as const;
const DEFAULT_LAYOUT: RunDetailLayout = 'A';

/**
 * Server-persisted per-user UI preferences, optimistically updated.
 *
 * `runDetailLayout`, `lastTeamSlug` and `pinnedTeamSlugs` are the keys so far. The union lives in
 * `@auto-swe/shared` so the gateway's Zod schema, the toggle and this hook
 * cannot drift apart again (they once disagreed on the member names, so every
 * PATCH was a 400). The stored value is validated on read because the column
 * is free-form JSON that older clients may have written.
 */
export function useUserPreferences() {
  const qc = useQueryClient();

  const { data } = useQuery({
    queryFn: () =>
      api.get<PreferencesResponse>('/api/v1/me/preferences').then((r) => r.preferences),
    queryKey: QUERY_KEY,
    staleTime: 5 * 60 * 1000,
  });

  const mutation = useMutation({
    mutationFn: (patch: Partial<UserPreferences>) =>
      api.patch<PreferencesResponse>('/api/v1/me/preferences', patch),
    onError: (_err, _vars, ctx) => {
      if (ctx) {
        qc.setQueryData(QUERY_KEY, ctx);
      }
    },
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: QUERY_KEY });
      const prev = qc.getQueryData<UserPreferences>(QUERY_KEY);
      qc.setQueryData(QUERY_KEY, { ...prev, ...patch });
      return prev;
    },
    // Reconcile the optimistic value with what the server actually stored.
    onSettled: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const pinned = Array.isArray(data?.pinnedTeamSlugs)
    ? data.pinnedTeamSlugs.filter((slug): slug is string => typeof slug === 'string')
    : [];
  return {
    /** The last team space visited; a hint, resolved through the member team list. */
    lastTeamSlug: typeof data?.lastTeamSlug === 'string' ? data.lastTeamSlug : null,
    layout: isRunDetailLayout(data?.runDetailLayout) ? data.runDetailLayout : DEFAULT_LAYOUT,
    /** False until the stored preferences have been read. */
    loaded: data !== undefined,
    pinnedTeamSlugs: pinned,
    setLastTeamSlug: (slug: string) => mutation.mutate({ lastTeamSlug: slug }),
    setLayout: (layout: RunDetailLayout) => mutation.mutate({ runDetailLayout: layout }),
  };
}
