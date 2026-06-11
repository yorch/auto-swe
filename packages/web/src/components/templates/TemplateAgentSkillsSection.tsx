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

function RoleToolEditor({ templateId, role }: { templateId: string; role: AgentRoleKey }) {
  const qc = useQueryClient();

  const { data: templateConfig } = useQuery({
    queryFn: () =>
      api
        .get<{ data: ToolConfig }>(
          `/api/v1/admin/agents/${role}/tools?scope=WORKFLOW_TEMPLATE&workflowTemplateId=${templateId}`
        )
        .then((r) => r.data)
        .catch(() => null),
    queryKey: ['template-agent-tools', templateId, role],
  });

  const { data: globalConfig } = useQuery({
    queryFn: () =>
      api
        .get<{ data: ToolConfig }>(`/api/v1/admin/agents/${role}/tools?scope=GLOBAL`)
        .then((r) => r.data)
        .catch(() => null),
    queryKey: ['admin-agent-tools-global', role],
  });

  const saveOverride = useMutation({
    mutationFn: (enabledTools: string[]) =>
      api.put(`/api/v1/admin/agents/${role}/tools`, {
        enabledTools,
        scope: 'WORKFLOW_TEMPLATE',
        workflowTemplateId: templateId,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['template-agent-tools', templateId, role] }),
  });

  const resetToGlobal = useMutation({
    mutationFn: () =>
      api.delete(
        `/api/v1/admin/agents/${role}/tools?scope=WORKFLOW_TEMPLATE&workflowTemplateId=${templateId}`
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['template-agent-tools', templateId, role] }),
  });

  return (
    <ToolAccessEditor
      dimInherited={false}
      globalConfig={globalConfig ?? null}
      hasOverride={!!templateConfig}
      idInfix="tpl-"
      inheritingLabel="inheriting cascade"
      onReset={() => resetToGlobal.mutateAsync()}
      onSave={(enabledTools) => saveOverride.mutateAsync(enabledTools)}
      overrideConfig={templateConfig ?? null}
      resetButtonLabel="Reset to Cascade"
      resetConfirm="Reset to inherited tool config for this role?"
      resetPending={resetToGlobal.isPending}
      role={role}
      savePending={saveOverride.isPending}
    />
  );
}

function RoleSkillEditor({ templateId, role }: { templateId: string; role: AgentRoleKey }) {
  const qc = useQueryClient();

  const { data: templateAssignmentsRaw } = useQuery({
    queryFn: () =>
      api
        .get<{ data: Assignment[] }>(
          `/api/v1/admin/agents/${role}/skills?scope=WORKFLOW_TEMPLATE&workflowTemplateId=${templateId}`
        )
        .then((r) => r.data),
    queryKey: ['template-agent-skills', templateId, role],
  });

  const { data: globalAssignmentsRaw } = useQuery({
    queryFn: () =>
      api
        .get<{ data: Assignment[] }>(`/api/v1/admin/agents/${role}/skills?scope=GLOBAL`)
        .then((r) => r.data),
    queryKey: ['admin-agent-skills-global', role],
  });

  const { data: allSkills } = useQuery({
    queryFn: () => api.get<{ data: Skill[] }>('/api/v1/admin/skills').then((r) => r.data),
    queryKey: ['admin-skills-library'],
  });

  const saveOverride = useMutation({
    mutationFn: (skillIds: string[]) =>
      api.put(`/api/v1/admin/agents/${role}/skills`, {
        scope: 'WORKFLOW_TEMPLATE',
        skillIds,
        workflowTemplateId: templateId,
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['template-agent-skills', templateId, role] }),
  });

  const resetToGlobal = useMutation({
    mutationFn: () =>
      api.delete(
        `/api/v1/admin/agents/${role}/skills?scope=WORKFLOW_TEMPLATE&workflowTemplateId=${templateId}`
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['template-agent-skills', templateId, role] }),
  });

  const templateAssignments = templateAssignmentsRaw ?? [];
  const globalAssignments = globalAssignmentsRaw ?? [];
  const hasOverride = templateAssignments.length > 0;

  return (
    <SkillAssignmentEditor
      baseAssignments={hasOverride ? templateAssignments : globalAssignments}
      dimInherited={false}
      globalAssignments={globalAssignments}
      hasOverride={hasOverride}
      idInfix="tpl-"
      inheritingLabel="inheriting cascade"
      onReset={() => resetToGlobal.mutateAsync()}
      onSave={(skillIds) => saveOverride.mutateAsync(skillIds)}
      resetButtonLabel="Reset to Cascade"
      resetConfirm="Reset to inherited skill assignments for this role?"
      resetPending={resetToGlobal.isPending}
      role={role}
      savePending={saveOverride.isPending}
      showBuiltInBadge
      skills={allSkills}
    />
  );
}

export function TemplateAgentSkillsSection({ templateId }: { templateId: string }) {
  return (
    <AgentConfigSection
      description={
        <>
          Override tool access and prompt-fragment skills for each agent role on runs using this
          template. &quot;Inheriting cascade&quot; means no template-level override is set — the
          team or global config applies instead.
        </>
      }
      eyebrow="Template Config"
      renderRole={(role) => (
        <>
          {ROLES_WITH_TOOLS.has(role) && <RoleToolEditor role={role} templateId={templateId} />}
          <RoleSkillEditor role={role} templateId={templateId} />
        </>
      )}
    />
  );
}
