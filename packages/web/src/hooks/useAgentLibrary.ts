import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type AgentScope = 'GLOBAL' | 'TEAM' | 'WORKFLOW_TEMPLATE';

export interface AgentSkillRef {
  id: string;
  skillId: string;
  sortOrder: number;
  skill: { id: string; name: string };
}

export interface AgentRow {
  id: string;
  key: string;
  scope: AgentScope;
  teamId: string | null;
  workflowTemplateId: string | null;
  version: number;
  name: string;
  description: string | null;
  modelSpec: string | null;
  systemPrompt: string | null;
  inheritsModelFrom: string | null;
  toolKeys: string[] | null;
  mcpConnectionId: string | null;
  credentialId: string | null;
  origin: string | null;
  isBuiltIn: boolean;
  isVerified: boolean;
  isActive: boolean;
  createdAt: string;
  skillRefs: AgentSkillRef[];
}

export interface SkillRefInput {
  skillId: string;
  sortOrder: number;
}

export interface CreateAgentBody {
  key: string;
  scope: AgentScope;
  teamId?: string;
  workflowTemplateId?: string;
  name: string;
  description?: string | null;
  modelSpec?: string | null;
  systemPrompt?: string | null;
  inheritsModelFrom?: string | null;
  toolKeys?: string[] | null;
  mcpConnectionId?: string | null;
  skillRefs?: SkillRefInput[] | null;
  credentialId?: string | null;
}

export type UpdateAgentBody = Partial<Omit<CreateAgentBody, 'key' | 'scope'>>;

const KEY = ['admin-agent-library'];

/** List Agents from the library (latest version per lineage by default). */
export function useAgentLibrary(filter?: { scope?: AgentScope; all?: boolean }) {
  const qs = new URLSearchParams();
  if (filter?.scope) {
    qs.set('scope', filter.scope);
  }
  if (filter?.all) {
    qs.set('all', 'true');
  }
  const query = qs.toString();
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: AgentRow[] }>(`/api/v1/admin/agent-library${query ? `?${query}` : ''}`)
        .then((r) => r.data),
    queryKey: [...KEY, filter?.scope ?? null, filter?.all ?? false],
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAgentBody) =>
      api.post<{ data: AgentRow; scanWarnings?: string[] }>('/api/v1/admin/agent-library', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateAgentBody }) =>
      api.put<{ data: AgentRow; scanWarnings?: string[] }>(
        `/api/v1/admin/agent-library/${id}`,
        body
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ data: { deactivated: number } }>(`/api/v1/admin/agent-library/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

// ── Team-scoped Agent library (team owners manage TEAM-scope agents) ──────────

const teamKey = (teamId: string) => ['team-agent-library', teamId];

/** List a team's TEAM-scope agents. */
export function useTeamAgents(teamId: string) {
  return useQuery({
    queryFn: () =>
      api.get<{ data: AgentRow[] }>(`/api/v1/teams/${teamId}/agent-library`).then((r) => r.data),
    queryKey: teamKey(teamId),
  });
}

export type CreateTeamAgentBody = Omit<CreateAgentBody, 'scope' | 'teamId' | 'workflowTemplateId'>;

export function useCreateTeamAgent(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTeamAgentBody) =>
      api.post<{ data: AgentRow; scanWarnings?: string[] }>(
        `/api/v1/teams/${teamId}/agent-library`,
        body
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: teamKey(teamId) }),
  });
}

export function useUpdateTeamAgent(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateAgentBody }) =>
      api.put<{ data: AgentRow; scanWarnings?: string[] }>(
        `/api/v1/teams/${teamId}/agent-library/${id}`,
        body
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: teamKey(teamId) }),
  });
}
