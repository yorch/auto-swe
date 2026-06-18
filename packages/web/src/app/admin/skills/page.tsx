'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { api } from '@/lib/api';

interface Skill {
  id: string;
  name: string;
  description: string | null;
  promptText: string;
  origin: string | null;
  isBuiltIn: boolean;
  isVerified: boolean;
  isActive: boolean;
  usedByCount: number;
  createdAt: string;
  updatedAt: string;
}

function useSkills() {
  return useQuery({
    queryFn: () => api.get<{ data: Skill[] }>('/api/v1/admin/skills').then((r) => r.data),
    queryKey: ['skills', 'all'],
  });
}

interface SkillEffectiveness {
  windowDays: number;
  totalRuns: number;
  baselineSuccessRate: number | null;
  caveat: string;
  perSkill: Array<{
    name: string;
    runs: number;
    successRate: number | null;
    avgCostUsd: number | null;
  }>;
}

function useSkillEffectiveness() {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: SkillEffectiveness }>('/api/v1/admin/skills/effectiveness')
        .then((r) => r.data),
    queryKey: ['skills', 'effectiveness'],
  });
}

function pct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(0)}%`;
}

function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description?: string; promptText: string }) =>
      api.post<{ data: Skill }>('/api/v1/admin/skills', body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      description?: string;
      promptText?: string;
      isActive?: boolean;
    }) => api.put<{ data: Skill }>(`/api/v1/admin/skills/${id}`, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/skills/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

function OriginBadge({ origin }: { origin: string | null }) {
  if (!origin) {
    return null;
  }
  return (
    <span className="ml-1.5 rounded bg-ink-600 px-1.5 py-0.5 font-mono text-[10px] text-paper-400">
      {origin}
    </span>
  );
}

// ── Skill Detail / Edit Modal ────────────────────────────────────────────────

function SkillDetailModal({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  const update = useUpdateSkill();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ description: '', isActive: true, name: '', promptText: '' });
  const [error, setError] = useState<string | null>(null);

  if (!skill) {
    return null;
  }

  function startEdit() {
    setForm({
      description: skill.description ?? '',
      isActive: skill.isActive,
      name: skill.name,
      promptText: skill.promptText,
    });
    setError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const patch: Parameters<typeof update.mutateAsync>[0] = { id: skill.id };
      if (form.name !== skill.name) {
        patch.name = form.name;
      }
      if (form.description !== (skill.description ?? '')) {
        patch.description = form.description;
      }
      if (form.isActive !== skill.isActive) {
        patch.isActive = form.isActive;
      }
      if (!skill.isBuiltIn && form.promptText !== skill.promptText) {
        patch.promptText = form.promptText;
      }
      await update.mutateAsync(patch);
      setEditing(false);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save skill');
    }
  }

  const title = editing ? `Edit "${skill.name}"` : skill.name;

  return (
    <Modal
      eyebrow="Admin / Skills"
      onClose={() => {
        setEditing(false);
        onClose();
      }}
      open={!!skill}
      size="lg"
      title={title}
    >
      {editing ? (
        <form className="space-y-4" onSubmit={handleSave}>
          <FieldWrapper label="Name">
            <Input
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
              value={form.name}
            />
          </FieldWrapper>
          <FieldWrapper label="Description">
            <Input
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              value={form.description}
            />
          </FieldWrapper>
          <FieldWrapper label="Prompt Text">
            {skill.isBuiltIn ? (
              <pre className="w-full rounded-sm border border-ink-500 bg-ink-800 px-3 py-2 text-xs text-paper-400 whitespace-pre-wrap break-words">
                {skill.promptText}
              </pre>
            ) : (
              <textarea
                className="w-full rounded-sm border border-ink-500 bg-ink-800 px-3 py-2 font-mono text-xs text-paper-100 placeholder-paper-500 focus:border-ember-400 focus:outline-none"
                onChange={(e) => setForm((f) => ({ ...f, promptText: e.target.value }))}
                required
                rows={12}
                value={form.promptText}
              />
            )}
            {skill.isBuiltIn && (
              <p className="mt-1 text-xs text-paper-500">
                Prompt text is locked for built-in skills.
              </p>
            )}
          </FieldWrapper>
          <FieldWrapper label="Active">
            <label className="flex cursor-pointer items-center gap-2">
              <button
                className={`h-5 w-10 rounded-full transition-colors ${
                  form.isActive ? 'bg-ember-400' : 'bg-ink-500'
                }`}
                onClick={() => setForm((f) => ({ ...f, isActive: !f.isActive }))}
                type="button"
              >
                <span
                  className={`block h-4 w-4 translate-x-0.5 rounded-full bg-paper-100 transition-transform ${
                    form.isActive ? 'translate-x-[1.375rem]' : ''
                  }`}
                />
              </button>
              <span className="text-sm text-paper-400">
                {form.isActive ? 'Enabled' : 'Disabled'}
              </span>
            </label>
          </FieldWrapper>
          {error && <p className="text-xs text-brick-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={cancelEdit} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={update.isPending} type="submit" variant="primary">
              {update.isPending ? 'Saving…' : 'Save Changes'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2 text-xs">
            {skill.isBuiltIn && (
              <span className="rounded bg-ink-600 px-2 py-0.5 font-mono uppercase tracking-wider text-paper-400">
                built-in
              </span>
            )}
            {skill.origin && (
              <span className="rounded bg-ink-600 px-2 py-0.5 font-mono text-paper-400">
                origin: {skill.origin}
              </span>
            )}
            {skill.isVerified && (
              <span className="rounded bg-green-900/60 px-2 py-0.5 font-mono text-green-400">
                verified
              </span>
            )}
            {!skill.isVerified && !skill.isBuiltIn && (
              <span className="rounded bg-amber-900/40 px-2 py-0.5 font-mono text-amber-400">
                unverified
              </span>
            )}
            <span
              className={`rounded px-2 py-0.5 font-mono ${
                skill.isActive ? 'bg-ember-900/40 text-ember-400' : 'bg-ink-600 text-paper-500'
              }`}
            >
              {skill.isActive ? 'active' : 'inactive'}
            </span>
            <span className="rounded bg-ink-600 px-2 py-0.5 font-mono text-paper-400">
              used by {skill.usedByCount} agent{skill.usedByCount !== 1 ? 's' : ''}
            </span>
          </div>
          {skill.description && <p className="text-sm text-paper-300">{skill.description}</p>}
          <div>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-paper-500">
              Prompt Text
            </div>
            <pre className="max-h-96 overflow-auto rounded-sm border border-ink-600 bg-ink-800 p-3 text-xs text-paper-200 whitespace-pre-wrap break-words">
              {skill.promptText}
            </pre>
          </div>
          <div className="flex items-center justify-between border-t border-ink-700 pt-4">
            <div className="space-y-0.5 text-xs text-paper-500">
              <div>Created {new Date(skill.createdAt).toLocaleDateString()}</div>
              <div>Updated {new Date(skill.updatedAt).toLocaleDateString()}</div>
            </div>
            <Button onClick={startEdit} variant="secondary">
              Edit
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Create Modal ─────────────────────────────────────────────────────────────

type SkillForm = {
  name: string;
  description: string;
  promptText: string;
};

function SkillFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState<SkillForm>({ description: '', name: '', promptText: '' });
  const create = useCreateSkill();
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({
        description: form.description || undefined,
        name: form.name,
        promptText: form.promptText,
      });
      onClose();
      setForm({ description: '', name: '', promptText: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create skill');
    }
  }

  return (
    <Modal eyebrow="Admin / Skills" onClose={onClose} open={open} title="New Skill">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <FieldWrapper label="Name">
          <Input
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
            value={form.name}
          />
        </FieldWrapper>
        <FieldWrapper label="Description">
          <Input
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            value={form.description}
          />
        </FieldWrapper>
        <FieldWrapper label="Prompt Text">
          <textarea
            className="w-full rounded-sm border border-ink-500 bg-ink-800 px-3 py-2 font-mono text-xs text-paper-100 placeholder-paper-500 focus:border-ember-400 focus:outline-none"
            onChange={(e) => setForm((f) => ({ ...f, promptText: e.target.value }))}
            required
            rows={8}
            value={form.promptText}
          />
        </FieldWrapper>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={create.isPending} type="submit" variant="primary">
            {create.isPending ? 'Creating…' : 'Create Skill'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Delete Confirm Modal ─────────────────────────────────────────────────────

function DeleteConfirmModal({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  const deleteSkill = useDeleteSkill();
  const [error, setError] = useState<string | null>(null);

  if (!skill) {
    return null;
  }

  async function handleDelete() {
    if (!skill) {
      return;
    }
    setError(null);
    try {
      await deleteSkill.mutateAsync(skill.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete skill');
    }
  }

  return (
    <Modal onClose={onClose} open={!!skill} title={`Delete "${skill.name}"?`}>
      <div className="space-y-4">
        <p className="text-sm text-paper-400">
          This will remove the skill and all its assignments. This cannot be undone.
        </p>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={deleteSkill.isPending} onClick={handleDelete} variant="danger">
            {deleteSkill.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Effectiveness Card ────────────────────────────────────────────────────────

function EffectivenessCard() {
  const { data, isLoading } = useSkillEffectiveness();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Skill effectiveness (last {data?.windowDays ?? 30} days)</CardTitle>
      </CardHeader>
      <p className="mb-3 text-xs text-paper-500">
        Run outcomes for runs where each skill was active, vs. the all-runs baseline (
        {pct(data?.baselineSuccessRate ?? null)} success across {data?.totalRuns ?? 0} runs).
        Correlational — skills are assigned per team/template, so differences may reflect the team
        or workload, not the skill.
      </p>
      {isLoading ? (
        <LoadingState />
      ) : !data?.perSkill.length ? (
        <div className="py-6 text-center text-sm text-paper-400">
          No runs with active skills in this window yet.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-600">
              <th className="py-2 text-left text-xs text-paper-500">Skill</th>
              <th className="py-2 text-right text-xs text-paper-500">Runs</th>
              <th className="py-2 text-right text-xs text-paper-500">Success rate</th>
              <th className="py-2 text-right text-xs text-paper-500">Avg cost</th>
            </tr>
          </thead>
          <tbody>
            {data.perSkill.map((s) => (
              <tr className="border-b border-ink-600 last:border-0" key={s.name}>
                <td className="py-2 pr-4 font-medium text-paper-100">{s.name}</td>
                <td className="py-2 text-right tabular-nums text-paper-400">{s.runs}</td>
                <td className="py-2 text-right tabular-nums text-paper-400">
                  {pct(s.successRate)}
                </td>
                <td className="py-2 text-right tabular-nums text-paper-400">
                  {s.avgCostUsd == null ? '—' : `$${s.avgCostUsd.toFixed(2)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AdminSkillsPage() {
  const [newOpen, setNewOpen] = useState(false);
  const [viewTarget, setViewTarget] = useState<Skill | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);
  const { data: skills, isLoading } = useSkills();
  const update = useUpdateSkill();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Skill Library</h2>
          <p className="mt-1 text-sm text-paper-400">
            Reusable prompt-fragment instructions injected into an agent&apos;s system prompt.
            Assigned to agent roles at any scope. Tool access control is managed separately via
            Agent Tool Access.
          </p>
        </div>
        <Button onClick={() => setNewOpen(true)} variant="primary">
          + New Skill
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Skills</CardTitle>
        </CardHeader>
        {isLoading ? (
          <LoadingState />
        ) : !skills?.length ? (
          <div className="py-8 text-center text-sm text-paper-400">
            No skills yet. Create one with the button above.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-600">
                <th className="py-2 text-left text-xs text-paper-500">Name</th>
                <th className="py-2 text-left text-xs text-paper-500">Description</th>
                <th className="py-2 text-left text-xs text-paper-500">Used by</th>
                <th className="py-2 text-left text-xs text-paper-500">Active</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr className="border-b border-ink-600 last:border-0" key={skill.id}>
                  <td className="py-2 pr-4">
                    <button
                      className="text-left hover:underline"
                      onClick={() => setViewTarget(skill)}
                      type="button"
                    >
                      <span className="font-medium text-paper-100">{skill.name}</span>
                    </button>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1">
                      {skill.isBuiltIn && (
                        <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
                          built-in
                        </span>
                      )}
                      {skill.origin && <OriginBadge origin={skill.origin} />}
                      {skill.isVerified && (
                        <span className="font-mono text-[10px] text-green-400">verified</span>
                      )}
                      {!skill.isVerified && !skill.isBuiltIn && (
                        <span className="font-mono text-[10px] text-amber-400">unverified</span>
                      )}
                    </div>
                  </td>
                  <td className="max-w-xs py-2 pr-4">
                    <span className="line-clamp-1 text-paper-400">{skill.description ?? '—'}</span>
                  </td>
                  <td className="py-2 pr-4 tabular-nums text-paper-400">{skill.usedByCount}</td>
                  <td className="py-2 pr-4">
                    <button
                      className={`h-5 w-10 rounded-full transition-colors ${
                        skill.isActive ? 'bg-ember-400' : 'bg-ink-500'
                      }`}
                      disabled={update.isPending}
                      onClick={() => update.mutate({ id: skill.id, isActive: !skill.isActive })}
                      title={skill.isActive ? 'Disable' : 'Enable'}
                      type="button"
                    >
                      <span
                        className={`block h-4 w-4 translate-x-0.5 rounded-full bg-paper-100 transition-transform ${
                          skill.isActive ? 'translate-x-[1.375rem]' : ''
                        }`}
                      />
                    </button>
                  </td>
                  <td className="py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button onClick={() => setViewTarget(skill)} size="sm" variant="ghost">
                        View / Edit
                      </Button>
                      {!skill.isBuiltIn && (
                        <Button onClick={() => setDeleteTarget(skill)} size="sm" variant="danger">
                          Delete
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <EffectivenessCard />

      <SkillFormModal onClose={() => setNewOpen(false)} open={newOpen} />
      <SkillDetailModal onClose={() => setViewTarget(null)} skill={viewTarget} />
      <DeleteConfirmModal onClose={() => setDeleteTarget(null)} skill={deleteTarget} />
    </div>
  );
}
