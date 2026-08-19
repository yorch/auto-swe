import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Scope levels an override can be attached to, most specific first. */
export type SettingScope = 'WORKFLOW_TEMPLATE' | 'CHANNEL' | 'TEAM' | 'ORGANIZATION' | 'GLOBAL';

/** Where a resolved value actually came from. */
export type SettingSource = SettingScope | 'PINNED' | 'ENV' | 'DEFAULT';

export interface SettingView {
  key: string;
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
        .get<{ data: SettingView[] }>(`/api/v1/admin/config/settings?${query}`)
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
        `/api/v1/admin/config/settings/${encodeURIComponent(key)}?${query}`,
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
        `/api/v1/admin/config/settings/${encodeURIComponent(key)}?${query}`
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
      api.get<{ data: ConfigGrant[] }>('/api/v1/admin/config/grants').then((r) => r.data),
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
    }) => api.post<{ data: ConfigGrant }>('/api/v1/admin/config/grants', body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config-grants'] }),
  });
}

export function useRevokeConfigGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/config/grants/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config-grants'] }),
  });
}
