'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ModelCatalogEntry, ModelKind, ModelStatus, RolePrice } from '@/lib/modelCatalog';

/** A spec in use that nothing prices, with where it is used and what it likely meant. */
export interface UnpricedModel {
  spec: string;
  usedBy: string[];
  suggestion: string | null;
}

export interface CatalogEntryInput {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  kind?: ModelKind;
  status?: ModelStatus;
  displayName?: string | null;
  notes?: string | null;
}

const BASE = '/api/v1/platform/model-catalog';

export function useModelCatalog(filter: { kind?: ModelKind; includeRetired?: boolean } = {}) {
  const qs = new URLSearchParams();
  if (filter.kind) {
    qs.set('kind', filter.kind);
  }
  if (filter.includeRetired) {
    qs.set('includeRetired', 'true');
  }
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: ModelCatalogEntry[] }>(`${BASE}${qs.size ? `?${qs}` : ''}`)
        .then((r) => r.data),
    queryKey: ['model-catalog', filter.kind ?? null, filter.includeRetired ?? false],
  });
}

export function useUnpricedModels() {
  return useQuery({
    queryFn: () => api.get<{ data: UnpricedModel[] }>(`${BASE}/unpriced`).then((r) => r.data),
    queryKey: ['model-catalog-unpriced'],
  });
}

/// A catalog write can move a model on or off the unpriced report too.
function invalidateCatalog(qc: ReturnType<typeof useQueryClient>): void {
  qc.invalidateQueries({ queryKey: ['model-catalog'] });
  qc.invalidateQueries({ queryKey: ['model-catalog-unpriced'] });
}

export function useCreateCatalogEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CatalogEntryInput & { provider: string; modelId: string }) =>
      api.post<{ data: ModelCatalogEntry }>(BASE, body),
    onSuccess: () => invalidateCatalog(qc),
  });
}

export function useUpdateCatalogEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<CatalogEntryInput> & { id: string }) =>
      api.put<{ data: ModelCatalogEntry }>(`${BASE}/${id}`, body),
    onSuccess: () => invalidateCatalog(qc),
  });
}

export function useResetCatalogEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: ModelCatalogEntry }>(`${BASE}/${id}/reset`, {}),
    onSuccess: () => invalidateCatalog(qc),
  });
}

export function useDeleteCatalogEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${BASE}/${id}`),
    onSuccess: () => invalidateCatalog(qc),
  });
}

/** A flag the discovery run stored. Neither kind changes the catalog or any price. */
export interface ModelSuggestion {
  id: string;
  provider: string;
  modelId: string;
  spec: string;
  /** NEW: listed by a provider, priced by nothing. RETIREMENT_CANDIDATE: priced here, no longer listed. */
  type: 'NEW' | 'RETIREMENT_CANDIDATE';
  kind: ModelKind;
  displayName: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  dismissedAt: string | null;
}

/** When a provider was last asked, and why it gave no answer. */
export interface DiscoveryProviderStatus {
  provider: string;
  checkedAt: string;
  lastSuccessAt: string | null;
  error: string | null;
}

/// What the scheduled (or last on-demand) discovery run stored.
export function useModelSuggestions(includeDismissed: boolean) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: { suggestions: ModelSuggestion[]; providers: DiscoveryProviderStatus[] } }>(
          `${BASE}/suggestions${includeDismissed ? '?includeDismissed=true' : ''}`
        )
        .then((r) => r.data),
    queryKey: ['model-catalog-suggestions', includeDismissed],
  });
}

export function useDismissSuggestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, dismiss }: { id: string; dismiss: boolean }) =>
      api.post(`${BASE}/suggestions/${id}/${dismiss ? 'dismiss' : 'undismiss'}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['model-catalog-suggestions'] }),
  });
}

/// "Check providers now": the gateway calls each GLOBAL provider credential's
/// list-models endpoint and refreshes the stored suggestions, as the schedule
/// does. It writes no catalog row, so only the suggestions are refetched.
export function useDiscoverModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`${BASE}/discover`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['model-catalog-suggestions'] }),
  });
}

/// Live per-role prices for the workflow editor's cost estimate. Readable by
/// any signed-in user; roles the gateway cannot price are absent.
export function useRolePricing() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: Record<string, RolePrice> }>(`${BASE}/role-pricing`).then((r) => r.data),
    queryKey: ['model-catalog', 'role-pricing'],
  });
}
