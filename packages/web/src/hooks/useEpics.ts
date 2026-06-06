'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useCreateEpic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { externalTicketId: string; description: string; repoIds: string[] }) =>
      api.post<{ data: { epicWorkflowId: string; workRequestId: string } }>('/api/v1/epics', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });
}
