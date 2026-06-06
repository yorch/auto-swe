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
  promptText: string;
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

interface ToolConfig {
  id: string;
  agentRole: string;
  scope: string;
  enabledTools: string[];
}

interface TeamAgentToolsResponse {
  data: {
    teamConfig: ToolConfig | null;
    globalConfig: ToolConfig | null;
    hasTeamOverride: boolean;
  };
}

const TOOL_KEYS = ['readFile', 'writeFile', 'listDirectory', 'bash'] as const;

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

// Only IMPLEMENTER uses tools currently
const ROLES_WITH_TOOLS = new Set(['IMPLEMENTER']);

function RoleToolEditor({ teamId, role }: { teamId: string; role: (typeof AGENT_ROLES)[number] }) {
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

  const [selectedTools, setSelectedTools] = useState<Set<string> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (isLoading || !data) {
    return <div className="py-2 text-center text-xs text-paper-400">Loading…</div>;
  }

  const { teamConfig, globalConfig, hasTeamOverride } = data;
  const baseTools = hasTeamOverride
    ? new Set<string>(teamConfig?.enabledTools ?? TOOL_KEYS)
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
    if (!window.confirm('Reset to global tool config for this role?')) {
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
          const isGlobal = globalConfig?.enabledTools.includes(key) ?? true;
          const isInherited = !hasTeamOverride && isGlobal;
          return (
            <label
              className={`flex cursor-pointer items-center gap-1.5 rounded-sm border p-1.5 text-xs transition-colors ${
                isInherited ? 'border-ink-600 opacity-60' : 'border-ink-600 hover:border-ink-500'
              }`}
              htmlFor={`${role}-tool-${key}`}
              key={key}
            >
              <input
                checked={checked}
                className="accent-ember-400"
                id={`${role}-tool-${key}`}
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
  );
}

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
    <div className="mt-2 rounded-sm border border-ink-600 p-3 space-y-2">
      <p className="text-xs text-paper-500">Skills (Prompt Fragments)</p>
      {!allSkills?.length ? (
        <p className="text-xs text-paper-400">No skills in library.</p>
      ) : (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {allSkills.map((skill) => {
            const checked = effectiveIds.has(skill.id);
            const isGlobal = globalAssignments.some((a) => a.skillId === skill.id);
            const isInherited = !hasTeamOverride && isGlobal;
            return (
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-sm border p-2 text-xs transition-colors ${
                  isInherited ? 'border-ink-600 opacity-60' : 'border-ink-600 hover:border-ink-500'
                }`}
                htmlFor={`${role}-skill-${skill.id}`}
                key={skill.id}
              >
                <input
                  checked={checked}
                  className="mt-0.5 accent-ember-400"
                  id={`${role}-skill-${skill.id}`}
                  onChange={() => toggleSkill(skill.id)}
                  type="checkbox"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium text-paper-100">{skill.name}</span>
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
      {saveError && <p className="text-xs text-brick-400">{saveError}</p>}
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
  );
}

function RoleEditor({ teamId, role }: { teamId: string; role: (typeof AGENT_ROLES)[number] }) {
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
          {hasTools && <RoleToolEditor role={role} teamId={teamId} />}
          <RoleSkillEditor role={role} teamId={teamId} />
        </div>
      )}
    </div>
  );
}

export function TeamAgentSkillsSection({ teamId }: { teamId: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Team Config">Agent Configuration</CardTitle>
      </CardHeader>
      <p className="mb-4 text-xs text-paper-400">
        Override tool access and prompt-fragment skills for each agent role on this team.
        &quot;Inheriting global&quot; means no team-level override is set. Click
        &quot;Override&quot; to activate a team-scoped configuration.
      </p>
      <div className="space-y-1">
        {AGENT_ROLES.map((role) => (
          <RoleEditor key={role} role={role} teamId={teamId} />
        ))}
      </div>
    </Card>
  );
}
