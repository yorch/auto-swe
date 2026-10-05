'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** An `mcp`-type Connection: an MCP server an Agent can bind tools from (P2/WS3). */
export interface McpConnectionRow {
  id: string;
  name: string | null;
  config: {
    url?: string;
    listTimeoutMs?: number;
    callTimeoutMs?: number;
    allowPrivateNetwork?: boolean;
  } | null;
  teamId: string;
  team?: { id: string; name: string; slug: string } | null;
  createdAt?: string;
  /** Whether a bearer token is stored. The token itself is never returned. */
  hasToken?: boolean;
  /** Names of the stored custom headers. Their values are never returned. */
  headerNames?: string[];
  /** True when stored headers exist but can no longer be read (they must be re-entered). */
  headersUnreadable?: boolean;
  /** Agents whose current version binds this server. */
  usedBy?: { key: string; name: string; scope: string }[];
}

export interface McpTestResult {
  ok: boolean;
  error?: string;
  toolCount?: number;
  toolNames?: string[];
  durationMs: number;
}

/** A custom header to send. On an edit, omitting `value` keeps the stored value of that name. */
export interface McpHeaderInput {
  name: string;
  value?: string;
}

export interface CreateMcpConnectionBody {
  /** Waives the private-network refusal for this server (never loopback or metadata addresses). */
  allowPrivateNetwork?: boolean;
  /** Custom request headers; values are write-only. */
  headers?: { name: string; value: string }[];
  /** Optional bearer token the server requires. Write-only. */
  bearerToken?: string;
  name: string;
  url: string;
  teamId: string;
  /** Optional override of `loadMcpTools`'s list-timeout (default 15 s). */
  listTimeoutMs?: number;
  /** Optional override of `loadMcpTools`'s per-call timeout (default 60 s). */
  callTimeoutMs?: number;
}

const BASE = '/api/v1/platform/mcp-connections';
const KEY = ['admin-mcp-connections'];

/**
 * The platform MCP connection list — `GET /platform/mcp-connections` is
 * ADMIN-only, so a caller rendering for a non-ADMIN passes `enabled: false`
 * rather than firing a request that can only 403.
 */
export function useMcpConnections(opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
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

export interface UpdateMcpConnectionBody {
  allowPrivateNetwork?: boolean;
  /** The complete header set after the edit; omit to keep every stored header. */
  headers?: McpHeaderInput[];
  /** Replaces the stored token. Omit to keep it. */
  bearerToken?: string;
  /** Removes the stored token. */
  clearBearerToken?: boolean;
  name: string;
  url: string;
  /** Optional override of `loadMcpTools`'s list-timeout (default 15 s). Omit to clear. */
  listTimeoutMs?: number;
  /** Optional override of `loadMcpTools`'s per-call timeout (default 60 s). Omit to clear. */
  callTimeoutMs?: number;
}

export function useUpdateMcpConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateMcpConnectionBody }) =>
      api.patch<{ data: McpConnectionRow }>(`${BASE}/${id}`, body).then((r) => r.data),
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

/** Connect to the saved server and list its tools; the result says why when it cannot. */
export function useTestMcpConnection() {
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: McpTestResult }>(`${BASE}/${id}/test`, {}).then((r) => r.data),
  });
}
