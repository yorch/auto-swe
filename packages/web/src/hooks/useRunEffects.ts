'use client';

import type { RunEffectDto } from '@auto-swe/shared/types/api';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** What a run changed outside the sandbox (docs/audit-log.md §5). */
export function useRunEffects(runId: string, live: boolean) {
  return useQuery({
    enabled: !!runId,
    queryFn: () =>
      api
        .get<{ data: RunEffectDto[]; truncated: boolean }>(`/api/v1/workflow-runs/${runId}/effects`)
        .then((r) => r),
    queryKey: ['run-effects', runId],
    // Effects land as the run works, so a live run is re-read.
    refetchInterval: live ? 15_000 : false,
  });
}
