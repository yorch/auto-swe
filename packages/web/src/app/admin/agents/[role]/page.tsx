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
  type: 'TOOL' | 'PROMPT_FRAGMENT';
  toolKey: string | null;
  promptText: string | null;
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

const ROLE_LABELS: Record<string, string> = {
  COMMIT_TO_MEMORY: 'Commit to Memory',
  IMPLEMENTER: 'Implementer',
  PLANNER: 'Planner',
  REVIEWER: 'Reviewer',
  SECURITY_REVIEW: 'Security Review',
  VALIDATE_CONTEXT: 'Validate Context',
};

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

const TYPE_BADGE: Record<string, string> = {
  PROMPT_FRAGMENT: 'bg-violet-400/10 text-violet-400 border-violet-400/30',
  TOOL: 'bg-ember-400/10 text-ember-400 border-ember-400/30',
};

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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link className="text-ember-400 hover:underline text-sm" href="/admin/agents">
          &larr; All Agents
        </Link>
        <h2 className="text-2xl font-bold">{label}</h2>
        <span className="font-mono text-[11px] uppercase tracking-wider text-paper-500">
          {role}
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Global">Skill Assignments</CardTitle>
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
          Select which skills are available to this agent role at the global scope. Team-scoped
          overrides are managed from the team detail page.
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
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-paper-100">{skill.name}</span>
                      <span
                        className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${TYPE_BADGE[skill.type] ?? ''}`}
                      >
                        {skill.type === 'TOOL' ? 'Tool' : 'Prompt'}
                      </span>
                      {skill.isBuiltIn && (
                        <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
                          built-in
                        </span>
                      )}
                    </div>
                    {skill.description && (
                      <p className="mt-0.5 text-xs text-paper-400">{skill.description}</p>
                    )}
                    {skill.type === 'TOOL' && skill.toolKey && (
                      <p className="mt-0.5 font-mono text-[10px] text-paper-500">
                        toolKey: {skill.toolKey}
                      </p>
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
          . Skills here control which tools are active and inject additional prompt fragments for
          this role.
        </p>
      </div>
    </div>
  );
}
