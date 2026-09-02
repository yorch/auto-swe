import type { SettingScope, SettingSource } from '@auto-swe/shared/config/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// Re-exported from the registry itself rather than kept as a second literal
// union — the web package already takes type-only imports from shared, and a
// hand-kept copy would silently disagree the day a scope is added.
export type { SettingScope, SettingSource } from '@auto-swe/shared/config/types';

export interface SettingView {
  key: string;
  /// Whether the signed-in user may write this key at the requested scope,
  /// decided server-side so it accounts for grants and not just the role floor.
  canWrite: boolean;
  group: string;
  label: string;
  description: string;
  value: unknown;
  source: SettingSource;
  defaultValue: unknown;
  overrideAtScope?: unknown;
  overridableAt: SettingScope[];
  requiredRole: 'ADMIN' | 'LEAD' | 'ENGINEER';
  restartRequired: boolean;
  runPinned: boolean;
  unit?: string;
}

export interface ScopeSelection {
  scope: SettingScope;
  teamId?: string;
  orgId?: string;
  channelId?: string;
  workflowTemplateId?: string;
}

function scopeQuery(selection: ScopeSelection): string {
  const params = new URLSearchParams({ scope: selection.scope });
  for (const key of ['teamId', 'orgId', 'channelId', 'workflowTemplateId'] as const) {
    const value = selection[key];
    if (value) {
      params.set(key, value);
    }
  }
  return params.toString();
}

export function useConfigSettings(selection: ScopeSelection) {
  const query = scopeQuery(selection);
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: SettingView[] }>(`/api/v1/platform/config/settings?${query}`)
        .then((r) => r.data),
    queryKey: ['config-settings', query],
  });
}

export function useSetConfigSetting(selection: ScopeSelection) {
  const qc = useQueryClient();
  const query = scopeQuery(selection);
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      api.put<{ data: unknown }>(
        `/api/v1/platform/config/settings/${encodeURIComponent(key)}?${query}`,
        { value }
      ),
    // A write at one scope changes what broader scopes resolve to, so refresh
    // every cached scope rather than only the one just written.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config-settings'] }),
  });
}

export function useClearConfigSetting(selection: ScopeSelection) {
  const qc = useQueryClient();
  const query = scopeQuery(selection);
  return useMutation({
    mutationFn: (key: string) =>
      api.delete<{ data: { cleared: boolean } }>(
        `/api/v1/platform/config/settings/${encodeURIComponent(key)}?${query}`
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config-settings'] }),
  });
}

export interface ConfigGrant {
  id: string;
  keyPattern: string;
  userId: string | null;
  role: 'ADMIN' | 'LEAD' | 'ENGINEER' | null;
  scope: 'GLOBAL' | 'ORGANIZATION' | 'TEAM';
  teamId: string | null;
  orgId: string | null;
  createdAt: string;
  user?: { email: string } | null;
  team?: { name: string } | null;
  organization?: { name: string } | null;
}

export function useConfigGrants() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: ConfigGrant[] }>('/api/v1/platform/config/grants').then((r) => r.data),
    queryKey: ['config-grants'],
  });
}

export function useCreateConfigGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      keyPattern: string;
      role?: 'ADMIN' | 'LEAD' | 'ENGINEER';
      userId?: string;
      scope: 'GLOBAL' | 'ORGANIZATION' | 'TEAM';
      teamId?: string;
      orgId?: string;
    }) =>
      api.post<{ data: ConfigGrant }>('/api/v1/platform/config/grants', body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config-grants'] }),
  });
}

export function useRevokeConfigGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/platform/config/grants/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config-grants'] }),
  });
}
