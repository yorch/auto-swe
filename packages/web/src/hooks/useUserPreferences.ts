'use client';

import { RUN_DETAIL_LAYOUTS, type RunDetailLayout } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface UserPreferences {
  runDetailLayout?: RunDetailLayout;
}

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
 * `runDetailLayout` is the one key so far. The union lives in
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
    mutationFn: (layout: RunDetailLayout) =>
      api.patch<PreferencesResponse>('/api/v1/me/preferences', { runDetailLayout: layout }),
    onError: (_err, _vars, ctx) => {
      if (ctx) {
        qc.setQueryData(QUERY_KEY, ctx);
      }
    },
    onMutate: async (layout) => {
      await qc.cancelQueries({ queryKey: QUERY_KEY });
      const prev = qc.getQueryData<UserPreferences>(QUERY_KEY);
      qc.setQueryData(QUERY_KEY, { ...prev, runDetailLayout: layout });
      return prev;
    },
    // Reconcile the optimistic value with what the server actually stored.
    onSettled: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return {
    layout: isRunDetailLayout(data?.runDetailLayout) ? data.runDetailLayout : DEFAULT_LAYOUT,
    setLayout: mutation.mutate,
  };
}
