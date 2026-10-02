'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface McpGrant {
  clientId: string;
  clientName: string | null;
  /** Every redirect URI the client registered. */
  redirectUris: string[];
  scopes: string[];
  grantedAt: string;
}

export interface McpGrantsResponse {
  data: McpGrant[];
  /** The operator switches: what a connected app can be granted right now. */
  mcp: { enabled: boolean; writeToolsEnabled: boolean };
}

const KEY = ['mcp-grants'];

export function useMcpGrants() {
  return useQuery({
    queryFn: () => api.get<McpGrantsResponse>('/api/v1/me/mcp-grants'),
    queryKey: KEY,
  });
}

export function useRevokeMcpGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clientId: string) =>
      api.delete(`/api/v1/me/mcp-grants/${encodeURIComponent(clientId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
