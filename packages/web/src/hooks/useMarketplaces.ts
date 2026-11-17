'use client';

import type {
  CatalogEntryDto,
  MarketplaceCatalogDto,
  MarketplaceDetailDto,
  MarketplaceLocation,
  MarketplaceSourceDto,
  MarketplaceSourceStatus,
  PluginMcpServer,
} from '@auto-swe/shared/lib/marketplace';
import type { HarnessProfilePreview } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ProjectionResult } from './useHarnessProfiles';

/**
 * Plugin marketplaces (`/api/v1/platform/marketplaces`, ADMIN-only): a repository holding a
 * `.claude-plugin/marketplace.json` catalog, pinned to a commit. Every string that came from the
 * repository (names, descriptions, paths, warnings) is untrusted: render it through `visibleText`.
 * Nothing is written until an entry is approved, which names the previewed commit, `contentHash`
 * and `warningsHash`.
 */

export type {
  CatalogEntryDto,
  MarketplaceCatalogDto,
  MarketplaceDetailDto,
  MarketplaceLocation,
  MarketplaceSourceDto,
  MarketplaceSourceStatus,
  PluginMcpServer,
};

/** A preview of one catalog entry: the profile preview plus what the plugin's MCP and hooks declare. */
export type EntryPreview = HarnessProfilePreview & {
  mcpServers: PluginMcpServer[];
  hasHooks: boolean;
  entry: {
    name: string | null;
    description: string | null;
    source: CatalogEntryDto['source'] | null;
    version: string | null;
  };
};

/** The catalog preview before a marketplace is added. */
export interface MarketplacePreview {
  catalog: MarketplaceCatalogDto;
  existingId: string | null;
  sha: string;
  source: MarketplaceLocation;
}

export interface EntryApproveInput {
  entry: string;
  sha: string;
  contentHash: string;
  warningsHash: string;
  acknowledgeWarnings: boolean;
  /** Required: a platform ADMIN decides the hook switch at approval, there is no default. */
  hooksEnabled: boolean;
}

export interface EntryApproveResult {
  id: string;
  name: string;
  version: number;
  commitSha: string;
  hooksEnabled: boolean;
  projection: ProjectionResult | null;
}

export interface MarketplaceCheckResult {
  check: { status: MarketplaceSourceStatus | 'SKIPPED'; error: string | null };
  recorded: boolean;
  source: MarketplaceSourceDto | null;
}

const BASE = '/api/v1/platform/marketplaces';
const KEY = ['marketplaces'];
const idUrl = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export function useMarketplaces() {
  return useQuery({
    queryFn: () => api.get<{ data: MarketplaceSourceDto[] }>(BASE).then((r) => r.data),
    queryKey: KEY,
  });
}

export function useMarketplace(id: string | null) {
  return useQuery({
    enabled: id !== null,
    queryFn: () => api.get<{ data: MarketplaceDetailDto }>(idUrl(id as string)).then((r) => r.data),
    queryKey: [...KEY, 'detail', id],
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: KEY }),
      // An approved entry is a new plugin.
      qc.invalidateQueries({ queryKey: ['harness-profiles'] }),
      qc.invalidateQueries({ queryKey: ['skills'] }),
      qc.invalidateQueries({ queryKey: ['admin-agent-library'] }),
      qc.invalidateQueries({ queryKey: ['team-agent-library'] }),
      qc.invalidateQueries({ queryKey: ['team-plugins'] }),
    ]);
}

/** Reads the catalog at a ref (or the named commit); writes nothing. */
export function usePreviewMarketplace() {
  return useMutation({
    mutationFn: (body: MarketplaceLocation & { sha?: string }) =>
      api.post<{ data: MarketplacePreview }>(`${BASE}/preview`, body).then((r) => r.data),
  });
}

export function useAddMarketplace() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: MarketplaceLocation & { sha: string }) =>
      api.post<{ data: MarketplaceSourceDto }>(BASE, body).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function usePatchMarketplace() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'OK' | 'DISABLED' }) =>
      api.patch<{ data: MarketplaceSourceDto }>(idUrl(id), { status }).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useDeleteMarketplace() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.delete(idUrl(id)),
    onSuccess: invalidate,
  });
}

export function useCheckMarketplace() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: MarketplaceCheckResult }>(`${idUrl(id)}/check`, {}).then((r) => r.data),
    onSuccess: invalidate,
  });
}

/** Moves the pin to a commit the admin has looked at. */
export function useAcceptMarketplaceUpdate() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, sha }: { id: string; sha: string }) =>
      api.post<{ data: MarketplaceSourceDto }>(`${idUrl(id)}/accept-update`, { sha }),
    onSuccess: invalidate,
  });
}

export function usePreviewEntry() {
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; entry: string; sha?: string }) =>
      api.post<{ data: EntryPreview }>(`${idUrl(id)}/entries/preview`, body).then((r) => r.data),
  });
}

export function useApproveEntry() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & EntryApproveInput) =>
      api
        .post<{ data: Omit<EntryApproveResult, 'projection'>; projection?: ProjectionResult }>(
          `${idUrl(id)}/entries/approve`,
          body
        )
        .then((r): EntryApproveResult => ({ ...r.data, projection: r.projection ?? null })),
    onSuccess: invalidate,
  });
}
