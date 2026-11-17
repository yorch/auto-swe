'use client';

import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface TicketPreview {
  configured: boolean;
  found: boolean;
  title: string | null;
  status: string | null;
  url: string | null;
}

/** Looks up a ticket's title and status on demand; never the ticket body. */
export function useTicketPreview() {
  return useMutation({
    mutationFn: ({ ticketId, connectionId }: { ticketId: string; connectionId: string }) =>
      api
        .get<{ data: TicketPreview }>(
          `/api/v1/tickets/preview?ticketId=${encodeURIComponent(ticketId)}&connectionId=${encodeURIComponent(connectionId)}`
        )
        .then((r) => r.data),
  });
}
