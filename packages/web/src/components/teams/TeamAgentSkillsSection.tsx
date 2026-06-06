'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { api } from '@/lib/api';

interface Skill {
  id: string;
  name: string;
  description: string | null;
  type: 'TOOL' | 'PROMPT_FRAGMENT';
  toolKey: string | null;
  isBuiltIn: boolean;
}

interface Assignment {
  id: string;
  skillId: string;
  sortOrder: number;
  skill: Skill;
}

interface TeamAgentSkillsResponse {
  data: {
    teamAssignments: Assignment[];
    globalAssignments: Assignment[];
    hasTeamOverride: boolean;
  };
}

const AGENT_ROLES = [
  'IMPLEMENTER',
  'REVIEWER',
  'PLANNER',
  'SECURITY_REVIEW',
  'VALIDATE_CONTEXT',
  'COMMIT_TO_MEMORY',
] as const;

const ROLE_LABELS: Record<string, string> = {
  COMMIT_TO_MEMORY: 'Commit to Memory',
  IMPLEMENTER: 'Implementer',
  PLANNER: 'Planner',
  REVIEWER: 'Reviewer',
  SECURITY_REVIEW: 'Security Review',
  VALIDATE_CONTEXT: 'Validate Context',
};

const TYPE_BADGE: Record<string, string> = {
  PROMPT_FRAGMENT: 'bg-violet-400/10 text-violet-400 border-violet-400/30',
  TOOL: 'bg-ember-400/10 text-ember-400 border-ember-400/30',
};

function RoleSkillEditor({ teamId, role }: { teamId: string; role: (typeof AGENT_ROLES)[number] }) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryFn: () =>
      api
        .get<TeamAgentSkillsResponse>(`/api/v1/teams/${teamId}/agents/${role}/skills`)
        .then((r) => r.data),
    queryKey: ['team-agent-skills', teamId, role],
  });

  const { data: allSkills } = useQuery({
    queryFn: () => api.get<{ data: Skill[] }>('/api/v1/admin/skills').then((r) => r.data),
    queryKey: ['skills', 'all'],
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

  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (isLoading || !data) {
    return <div className="py-4 text-center text-xs text-paper-400">Loading…</div>;
  }

  const { teamAssignments, globalAssignments, hasTeamOverride } = data;
  const baseAssignments = hasTeamOverride ? teamAssignments : globalAssignments;
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
    if (!window.confirm('Reset to global skill assignments for this role?')) {
      return;
    }
    await resetToGlobal.mutateAsync();
    setSelectedIds(null);
    setSaved(false);
  }

  const isDirty = selectedIds !== null;

  return (
    <div className="border border-ink-600 rounded-sm p-4 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium text-paper-100">{ROLE_LABELS[role]}</span>
        <div className="flex items-center gap-2">
          {!hasTeamOverride && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
              inheriting global
            </span>
          )}
          {hasTeamOverride && (
            <Button
              disabled={resetToGlobal.isPending}
              onClick={handleReset}
              size="sm"
              variant="ghost"
            >
              Reset to Global
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
            {saveOverride.isPending ? 'Saving…' : hasTeamOverride ? 'Save' : 'Override'}
          </Button>
        </div>
      </div>

      {saveError && <p className="text-xs text-brick-400">{saveError}</p>}

      {!allSkills?.length ? (
        <p className="text-xs text-paper-400">No skills in library.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {allSkills.map((skill) => {
            const checked = effectiveIds.has(skill.id);
            const isGlobal = globalAssignments.some((a) => a.skillId === skill.id);
            const isInherited = !hasTeamOverride && isGlobal;
            return (
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-sm border p-2 text-xs transition-colors ${
                  isInherited ? 'border-ink-600 opacity-60' : 'border-ink-600 hover:border-ink-500'
                }`}
                htmlFor={`${role}-${skill.id}`}
                key={skill.id}
              >
                <input
                  checked={checked}
                  className="mt-0.5 accent-ember-400"
                  id={`${role}-${skill.id}`}
                  onChange={() => toggleSkill(skill.id)}
                  type="checkbox"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium text-paper-100">{skill.name}</span>
                    <span
                      className={`inline-flex items-center rounded-sm border px-1 py-0 font-mono text-[9px] uppercase tracking-wider ${TYPE_BADGE[skill.type] ?? ''}`}
                    >
                      {skill.type === 'TOOL' ? 'Tool' : 'Prompt'}
                    </span>
                    {isGlobal && (
                      <span className="font-mono text-[9px] uppercase tracking-wider text-paper-500">
                        global
                      </span>
                    )}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TeamAgentSkillsSection({ teamId }: { teamId: string }) {
  const [expandedRole, setExpandedRole] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Team Config">Agent Skills</CardTitle>
      </CardHeader>
      <p className="mb-4 text-xs text-paper-400">
        Override which skills each agent role uses for this team. "Inheriting global" means no
        team-level override is set — the global assignments apply. Click "Override" to activate a
        team-scoped assignment.
      </p>
      <div className="space-y-2">
        {AGENT_ROLES.map((role) => (
          <div key={role}>
            <button
              className="w-full flex items-center justify-between px-2 py-2 text-sm text-paper-300 hover:text-paper-100 transition-colors"
              onClick={() => setExpandedRole(expandedRole === role ? null : role)}
              type="button"
            >
              <span>{ROLE_LABELS[role]}</span>
              <span className="font-mono text-[11px]">{expandedRole === role ? '▲' : '▼'}</span>
            </button>
            {expandedRole === role && <RoleSkillEditor role={role} teamId={teamId} />}
          </div>
        ))}
      </div>
    </Card>
  );
}
