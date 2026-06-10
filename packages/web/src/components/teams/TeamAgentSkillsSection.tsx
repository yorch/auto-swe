'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AgentConfigSection,
  type Assignment,
  type Skill,
  SkillAssignmentEditor,
  ToolAccessEditor,
  type ToolConfig,
} from '@/components/agents/AgentConfigSection';
import { type AgentRoleKey, ROLES_WITH_TOOLS } from '@/lib/agentRoles';
import { api } from '@/lib/api';

interface TeamAgentSkillsResponse {
  data: {
    teamAssignments: Assignment[];
    globalAssignments: Assignment[];
    hasTeamOverride: boolean;
  };
}

interface TeamAgentToolsResponse {
  data: {
    teamConfig: ToolConfig | null;
    globalConfig: ToolConfig | null;
    hasTeamOverride: boolean;
  };
}

function RoleToolEditor({ teamId, role }: { teamId: string; role: AgentRoleKey }) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryFn: () =>
      api
        .get<TeamAgentToolsResponse>(`/api/v1/teams/${teamId}/agents/${role}/tools`)
        .then((r) => r.data),
    queryKey: ['team-agent-tools', teamId, role],
  });

  const saveOverride = useMutation({
    mutationFn: (enabledTools: string[]) =>
      api.put(`/api/v1/teams/${teamId}/agents/${role}/tools`, { enabledTools }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-agent-tools', teamId, role] }),
  });

  const resetToGlobal = useMutation({
    mutationFn: () => api.delete(`/api/v1/teams/${teamId}/agents/${role}/tools`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-agent-tools', teamId, role] }),
  });

  return (
    <ToolAccessEditor
      dimInherited
      globalConfig={data?.globalConfig ?? null}
      hasOverride={data?.hasTeamOverride ?? false}
      idInfix=""
      inheritingLabel="inheriting global"
      loading={isLoading || !data}
      onReset={() => resetToGlobal.mutateAsync()}
      onSave={(enabledTools) => saveOverride.mutateAsync(enabledTools)}
      overrideConfig={data?.teamConfig ?? null}
      resetButtonLabel="Reset to Global"
      resetConfirm="Reset to global tool config for this role?"
      resetPending={resetToGlobal.isPending}
      role={role}
      savePending={saveOverride.isPending}
    />
  );
}

function RoleSkillEditor({ teamId, role }: { teamId: string; role: AgentRoleKey }) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryFn: () =>
      api
        .get<TeamAgentSkillsResponse>(`/api/v1/teams/${teamId}/agents/${role}/skills`)
        .then((r) => r.data),
    queryKey: ['team-agent-skills', teamId, role],
  });

  const { data: allSkills } = useQuery({
    // Use the team-scoped skills endpoint (requires only team membership, not platform ADMIN).
    // The admin-only /api/v1/admin/skills would return 403 for ENGINEER-role users.
    queryFn: () => api.get<{ data: Skill[] }>(`/api/v1/teams/${teamId}/skills`).then((r) => r.data),
    queryKey: ['team-skills-library', teamId],
  });

  const saveOverride = useMutation({
    mutationFn: (skillIds: string[]) =>
      api.put(`/api/v1/teams/${teamId}/agents/${role}/skills`, { skillIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-agent-skills', teamId, role] }),
  });

  const resetToGlobal = useMutation({
    mutationFn: () => api.delete(`/api/v1/teams/${teamId}/agents/${role}/skills`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-agent-skills', teamId, role] }),
  });

  const hasOverride = data?.hasTeamOverride ?? false;

  return (
    <SkillAssignmentEditor
      baseAssignments={(hasOverride ? data?.teamAssignments : data?.globalAssignments) ?? []}
      dimInherited
      globalAssignments={data?.globalAssignments ?? []}
      hasOverride={hasOverride}
      idInfix=""
      inheritingLabel="inheriting global"
      loading={isLoading || !data}
      onReset={() => resetToGlobal.mutateAsync()}
      onSave={(skillIds) => saveOverride.mutateAsync(skillIds)}
      resetButtonLabel="Reset to Global"
      resetConfirm="Reset to global skill assignments for this role?"
      resetPending={resetToGlobal.isPending}
      role={role}
      savePending={saveOverride.isPending}
      showBuiltInBadge={false}
      skills={allSkills}
    />
  );
}

export function TeamAgentSkillsSection({ teamId }: { teamId: string }) {
  return (
    <AgentConfigSection
      description={
        <>
          Override tool access and prompt-fragment skills for each agent role on this team.
          &quot;Inheriting global&quot; means no team-level override is set. Click
          &quot;Override&quot; to activate a team-scoped configuration.
        </>
      }
      eyebrow="Team Config"
      renderRole={(role) => (
        <>
          {ROLES_WITH_TOOLS.has(role) && <RoleToolEditor role={role} teamId={teamId} />}
          <RoleSkillEditor role={role} teamId={teamId} />
        </>
      )}
    />
  );
}
