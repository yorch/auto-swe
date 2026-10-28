'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Has the signed-in user answered any gate, of any kind and outcome? One row is enough: the gateway
 * reports the true count in `meta.total`. Human steps are not filtered by the shell's selected
 * team, so there is nothing to opt out of. The key sits under `approvals`, so the approvals stream
 * refreshes it when a gate changes.
 */
export function useAnsweredGate() {
  return useQuery({
    queryFn: () =>
      api.get<{ meta: { total: number } }>(
        '/api/v1/human-steps?status=ALL&answeredByMe=true&limit=1'
      ),
    queryKey: ['approvals', 'answered-by-me'],
  });
}
