'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { api } from '@/lib/api';

interface Skill {
  id: string;
  name: string;
  description: string | null;
  promptText: string;
  isBuiltIn: boolean;
}

interface Assignment {
  id: string;
  agentRole: string;
  skillId: string;
  scope: string;
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

const ROLE_LABELS: Record<string, string> = {
  COMMIT_TO_MEMORY: 'Commit to Memory',
  IMPLEMENTER: 'Implementer',
  PLANNER: 'Planner',
  REVIEWER: 'Reviewer',
  SECURITY_REVIEW: 'Security Review',
  VALIDATE_CONTEXT: 'Validate Context',
};

// Only IMPLEMENTER uses tools currently
const ROLES_WITH_TOOLS = new Set(['IMPLEMENTER']);

function useAllSkills() {
  return useQuery({
    queryFn: () => api.get<{ data: Skill[] }>('/api/v1/admin/skills').then((r) => r.data),
    queryKey: ['skills', 'all'],
  });
}

function useRoleAssignments(role: string) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: Assignment[] }>(`/api/v1/admin/agents/${role}/skills?scope=GLOBAL`)
        .then((r) => r.data),
    queryKey: ['agent-skills', role, 'GLOBAL'],
  });
}

function useSaveRoleSkills(role: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skillIds: string[]) =>
      api.put(`/api/v1/admin/agents/${role}/skills`, { scope: 'GLOBAL', skillIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-skills', role] }),
  });
}

function useToolConfig(role: string) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: ToolConfig }>(`/api/v1/admin/agents/${role}/tools?scope=GLOBAL`)
        .then((r) => r.data)
        .catch(() => null),
    queryKey: ['agent-tool-config', role, 'GLOBAL'],
  });
}

function useSaveToolConfig(role: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabledTools: string[]) =>
      api.put(`/api/v1/admin/agents/${role}/tools`, { enabledTools, scope: 'GLOBAL' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-tool-config', role] }),
  });
}

function ToolAccessSection({ role }: { role: string }) {
  const { data: toolConfigData, isLoading } = useToolConfig(role);
  const saveToolConfig = useSaveToolConfig(role);
  const qc = useQueryClient();

  const currentTools = new Set<string>(toolConfigData?.enabledTools ?? TOOL_KEYS);
  const [selectedTools, setSelectedTools] = useState<Set<string> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const effectiveTools = selectedTools ?? currentTools;

  function toggleTool(key: string) {
    const base = selectedTools ?? new Set(currentTools);
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
      await saveToolConfig.mutateAsync([...effectiveTools]);
      setSaved(true);
      setSelectedTools(null);
      qc.invalidateQueries({ queryKey: ['agent-tool-config', role] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  const isDirty = selectedTools !== null;

  if (isLoading) {
    return <div className="py-4 text-center text-sm text-paper-400">Loading…</div>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-paper-400">
        Select which workspace tools this agent role can use at the global scope. Team-scoped
        overrides are managed from the team detail page.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TOOL_KEYS.map((key) => {
          const checked = effectiveTools.has(key);
          return (
            <label
              className="flex cursor-pointer items-center gap-2 rounded-sm border border-ink-600 p-3 transition-colors hover:border-ink-500"
              htmlFor={`tool-${key}`}
              key={key}
            >
              <input
                checked={checked}
                className="accent-ember-400"
                id={`tool-${key}`}
                onChange={() => toggleTool(key)}
                type="checkbox"
              />
              <span className="font-mono text-xs text-paper-100">{key}</span>
            </label>
          );
        })}
      </div>
      {saveError && <p className="text-xs text-brick-400">{saveError}</p>}
      <div className="flex items-center gap-2">
        {saved && (
          <span className="font-mono text-[11px] uppercase tracking-wider text-green-400">
            Saved
          </span>
        )}
        <Button
          disabled={!isDirty || saveToolConfig.isPending}
          onClick={handleSave}
          variant="primary"
        >
          {saveToolConfig.isPending ? 'Saving…' : 'Save Tool Access'}
        </Button>
      </div>
    </div>
  );
}


export default function AgentRoleDetailPage({ params }: { params: Promise<{ role: string }> }) {
  const { role } = use(params);
  const { data: allSkills } = useAllSkills();
  const { data: assignments, isLoading } = useRoleAssignments(role);
  const saveSkills = useSaveRoleSkills(role);

  const assignedIds = new Set(assignments?.map((a) => a.skillId) ?? []);
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Use DB state as default when not editing
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
      await saveSkills.mutateAsync([...effectiveIds]);
      setSaved(true);
      setSelectedIds(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  const isDirty = selectedIds !== null;
  const label = ROLE_LABELS[role] ?? role;
  const hasTools = ROLES_WITH_TOOLS.has(role);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link className="text-sm text-ember-400 hover:underline" href="/admin/agents">
          &larr; All Agents
        </Link>
        <h2 className="text-2xl font-bold">{label}</h2>
        <span className="font-mono text-[11px] uppercase tracking-wider text-paper-500">
          {role}
        </span>
      </div>

      {hasTools && (
        <Card>
          <CardHeader>
            <CardTitle eyebrow="Global">Tool Access</CardTitle>
          </CardHeader>
          <ToolAccessSection role={role} />
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Global">Skills (Prompt Fragments)</CardTitle>
          <div className="flex items-center gap-2">
            {saved && (
              <span className="font-mono text-[11px] uppercase tracking-wider text-green-400">
                Saved
              </span>
            )}
            <Button
              disabled={!isDirty || saveSkills.isPending}
              onClick={handleSave}
              variant="primary"
            >
              {saveSkills.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </CardHeader>

        <p className="mb-4 text-xs text-paper-400">
          Select which prompt-fragment skills are injected into this agent role&apos;s system prompt
          at the global scope. Team-scoped overrides are managed from the team detail page.
        </p>

        {saveError && <p className="mb-4 text-xs text-brick-400">{saveError}</p>}

        {isLoading ? (
          <div className="py-8 text-center text-sm text-paper-400">Loading…</div>
        ) : !allSkills?.length ? (
          <div className="py-8 text-center text-sm text-paper-400">
            No skills in the library yet.{' '}
            <Link className="text-ember-400 hover:underline" href="/admin/skills">
              Create skills first.
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {allSkills.map((skill) => {
              const checked = effectiveIds.has(skill.id);
              return (
                <label
                  className="flex cursor-pointer items-start gap-3 rounded-sm border border-ink-600 p-3 transition-colors hover:border-ink-500"
                  htmlFor={`skill-${skill.id}`}
                  key={skill.id}
                >
                  <input
                    checked={checked}
                    className="mt-0.5 accent-ember-400"
                    id={`skill-${skill.id}`}
                    onChange={() => toggleSkill(skill.id)}
                    type="checkbox"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-paper-100">{skill.name}</span>
                      {skill.isBuiltIn && (
                        <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
                          built-in
                        </span>
                      )}
                    </div>
                    {skill.description && (
                      <p className="mt-0.5 text-xs text-paper-400">{skill.description}</p>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </Card>

      <div className="rounded-sm border border-ink-600 bg-ink-800/40 p-4">
        <p className="text-xs text-paper-500">
          <strong className="text-paper-300">Model & System Prompt:</strong> Configured via{' '}
          <Link className="text-ember-400 hover:underline" href="/admin/model-config">
            Model Config
          </Link>
          . Skills here inject additional prompt fragments for this role; tool access controls which
          workspace tools are available.
        </p>
      </div>
    </div>
  );
}
