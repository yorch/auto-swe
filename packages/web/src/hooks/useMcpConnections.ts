'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** An `mcp`-type Connection: an MCP server an Agent can bind tools from (P2/WS3). */
export interface McpConnectionRow {
  id: string;
  name: string | null;
  config: { url?: string } | null;
  teamId: string;
  team?: { id: string; name: string; slug: string } | null;
  createdAt?: string;
}

export interface CreateMcpConnectionBody {
  name: string;
  url: string;
  teamId: string;
}

const BASE = '/api/v1/admin/mcp-connections';
const KEY = ['admin-mcp-connections'];

export function useMcpConnections() {
  return useQuery({
    queryFn: () => api.get<{ data: McpConnectionRow[] }>(BASE).then((r) => r.data),
    queryKey: KEY,
  });
}

export function useCreateMcpConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMcpConnectionBody) =>
      api.post<{ data: McpConnectionRow }>(BASE, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteMcpConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ data: { deactivated: boolean } }>(`${BASE}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
