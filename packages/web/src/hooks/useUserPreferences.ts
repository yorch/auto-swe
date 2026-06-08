'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

type RunDetailLayout = 'split' | 'inline';

interface UserPreferences {
  runDetailLayout?: RunDetailLayout;
}

interface PreferencesResponse {
  preferences: UserPreferences;
}

const QUERY_KEY = ['me-preferences'] as const;
const DEFAULT_LAYOUT: RunDetailLayout = 'split';

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
  });

  return {
    layout: data?.runDetailLayout ?? DEFAULT_LAYOUT,
    setLayout: mutation.mutate,
  };
}
