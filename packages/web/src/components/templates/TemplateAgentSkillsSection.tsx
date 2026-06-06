'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { AGENT_ROLES, ROLE_LABELS, ROLES_WITH_TOOLS } from '@/lib/agentRoles';
import { api } from '@/lib/api';

interface Skill {
  id: string;
  name: string;
  description: string | null;
  isBuiltIn: boolean;
}

interface Assignment {
  id: string;
  skillId: string;
  sortOrder: number;
  skill: Skill;
}

interface ToolConfig {
  id: string;
  agentRole: string;
  scope: string;
  enabledTools: string[];
}

const TOOL_KEYS = ['readFile', 'writeFile', 'listDirectory', 'bash'] as const;

function RoleToolEditor({
  templateId,
  role,
}: {
  templateId: string;
  role: (typeof AGENT_ROLES)[number];
}) {
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

  const [selectedTools, setSelectedTools] = useState<Set<string> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const hasTemplateOverride = !!templateConfig;
  const baseTools = hasTemplateOverride
    ? new Set<string>(templateConfig?.enabledTools ?? TOOL_KEYS)
    : new Set<string>(globalConfig?.enabledTools ?? TOOL_KEYS);
  const effectiveTools = selectedTools ?? baseTools;

  function toggleTool(key: string) {
    const base = selectedTools ?? new Set(baseTools);
    const next = new Set(base);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setSelectedTools(next);
    setSaved(false);
  }

  async function handleSave() {
    setSaveError(null);
    setSaved(false);
    try {
      await saveOverride.mutateAsync([...effectiveTools]);
      setSaved(true);
      setSelectedTools(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  async function handleReset() {
    if (!window.confirm('Reset to inherited tool config for this role?')) {
      return;
    }
    await resetToGlobal.mutateAsync();
    setSelectedTools(null);
    setSaved(false);
  }

  const isDirty = selectedTools !== null;

  return (
    <div className="mt-2 rounded-sm border border-ink-600 p-3 space-y-2">
      <p className="text-xs text-paper-500">Tool Access</p>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {TOOL_KEYS.map((key) => {
          const checked = effectiveTools.has(key);
          return (
            <label
              className="flex cursor-pointer items-center gap-1.5 rounded-sm border border-ink-600 p-1.5 text-xs transition-colors hover:border-ink-500"
              htmlFor={`${role}-tpl-tool-${key}`}
              key={key}
            >
              <input
                checked={checked}
                className="accent-ember-400"
                id={`${role}-tpl-tool-${key}`}
                onChange={() => toggleTool(key)}
                type="checkbox"
              />
              <span className="font-mono text-paper-100">{key}</span>
            </label>
          );
        })}
      </div>
      {saveError && <p className="text-xs text-brick-400">{saveError}</p>}
      <div className="flex items-center gap-2">
        {!hasTemplateOverride && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
            inheriting cascade
          </span>
        )}
        {hasTemplateOverride && (
          <Button
            disabled={resetToGlobal.isPending}
            onClick={handleReset}
            size="sm"
            variant="ghost"
          >
            Reset to Cascade
          </Button>
        )}
        {saved && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-green-400">
            Saved
          </span>
        )}
        <Button
          disabled={!isDirty || saveOverride.isPending}
          onClick={handleSave}
          size="sm"
          variant="primary"
        >
          {saveOverride.isPending ? 'Saving…' : hasTemplateOverride ? 'Save' : 'Override'}
        </Button>
      </div>
    </div>
  );
}

function RoleSkillEditor({
  templateId,
  role,
}: {
  templateId: string;
  role: (typeof AGENT_ROLES)[number];
}) {
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

  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const templateAssignments = templateAssignmentsRaw ?? [];
  const globalAssignments = globalAssignmentsRaw ?? [];
  const hasTemplateOverride = templateAssignments.length > 0;
  const baseAssignments = hasTemplateOverride ? templateAssignments : globalAssignments;
  const assignedIds = new Set(baseAssignments.map((a) => a.skillId));
  const effectiveIds = selectedIds ?? assignedIds;

  function toggleSkill(id: string) {
    const base = selectedIds ?? new Set(assignedIds);
    const next = new Set(base);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
    setSaved(false);
  }

  async function handleSave() {
    setSaveError(null);
    setSaved(false);
    try {
      await saveOverride.mutateAsync([...effectiveIds]);
      setSaved(true);
      setSelectedIds(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  async function handleReset() {
    if (!window.confirm('Reset to inherited skill assignments for this role?')) {
      return;
    }
    await resetToGlobal.mutateAsync();
    setSelectedIds(null);
    setSaved(false);
  }

  const isDirty = selectedIds !== null;

  return (
    <div className="mt-2 rounded-sm border border-ink-600 p-3 space-y-2">
      <p className="text-xs text-paper-500">Skills (Prompt Fragments)</p>
      {!allSkills?.length ? (
        <p className="text-xs text-paper-400">No skills in library.</p>
      ) : (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {allSkills.map((skill) => {
            const checked = effectiveIds.has(skill.id);
            const isGlobal = globalAssignments.some((a) => a.skillId === skill.id);
            return (
              <label
                className="flex cursor-pointer items-start gap-2 rounded-sm border border-ink-600 p-2 text-xs transition-colors hover:border-ink-500"
                htmlFor={`${role}-tpl-skill-${skill.id}`}
                key={skill.id}
              >
                <input
                  checked={checked}
                  className="mt-0.5 accent-ember-400"
                  id={`${role}-tpl-skill-${skill.id}`}
                  onChange={() => toggleSkill(skill.id)}
                  type="checkbox"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-paper-100">{skill.name}</span>
                    {isGlobal && (
                      <span className="font-mono text-[9px] uppercase tracking-wider text-paper-500">
                        global
                      </span>
                    )}
                    {skill.isBuiltIn && (
                      <span className="font-mono text-[9px] uppercase tracking-wider text-ember-400/70">
                        built-in
                      </span>
                    )}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      )}
      {saveError && <p className="text-xs text-brick-400">{saveError}</p>}
      <div className="flex items-center gap-2">
        {!hasTemplateOverride && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
            inheriting cascade
          </span>
        )}
        {hasTemplateOverride && (
          <Button
            disabled={resetToGlobal.isPending}
            onClick={handleReset}
            size="sm"
            variant="ghost"
          >
            Reset to Cascade
          </Button>
        )}
        {saved && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-green-400">
            Saved
          </span>
        )}
        <Button
          disabled={!isDirty || saveOverride.isPending}
          onClick={handleSave}
          size="sm"
          variant="primary"
        >
          {saveOverride.isPending ? 'Saving…' : hasTemplateOverride ? 'Save' : 'Override'}
        </Button>
      </div>
    </div>
  );
}

function RoleEditor({
  templateId,
  role,
}: {
  templateId: string;
  role: (typeof AGENT_ROLES)[number];
}) {
  const [expanded, setExpanded] = useState(false);
  const hasTools = ROLES_WITH_TOOLS.has(role);

  return (
    <div>
      <button
        className="flex w-full items-center justify-between px-2 py-2 text-sm text-paper-300 transition-colors hover:text-paper-100"
        onClick={() => setExpanded((v) => !v)}
        type="button"
      >
        <span>{ROLE_LABELS[role]}</span>
        <span className="font-mono text-[11px]">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="space-y-2 pb-2">
          {hasTools && <RoleToolEditor role={role} templateId={templateId} />}
          <RoleSkillEditor role={role} templateId={templateId} />
        </div>
      )}
    </div>
  );
}

export function TemplateAgentSkillsSection({ templateId }: { templateId: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Template Config">Agent Configuration</CardTitle>
      </CardHeader>
      <p className="mb-4 text-xs text-paper-400">
        Override tool access and prompt-fragment skills for each agent role on runs using this
        template. &quot;Inheriting cascade&quot; means no template-level override is set — the team
        or global config applies instead.
      </p>
      <div className="space-y-1">
        {AGENT_ROLES.map((role) => (
          <RoleEditor key={role} role={role} templateId={templateId} />
        ))}
      </div>
    </Card>
  );
}
