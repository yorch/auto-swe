'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { api } from '@/lib/api';

interface Skill {
  id: string;
  name: string;
  description: string | null;
  promptText: string;
  isBuiltIn: boolean;
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

function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description?: string; promptText: string }) =>
      api.post<{ data: Skill }>('/api/v1/admin/skills', body).then((r) => r.data),
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

type SkillForm = {
  name: string;
  description: string;
  promptText: string;
};

function SkillFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState<SkillForm>({
    description: '',
    name: '',
    promptText: '',
  });
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
            className="w-full rounded-sm border border-ink-500 bg-ink-800 px-3 py-2 text-sm text-paper-100 placeholder-paper-500 focus:border-ember-400 focus:outline-none"
            onChange={(e) => setForm((f) => ({ ...f, promptText: e.target.value }))}
            required
            rows={6}
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

export default function AdminSkillsPage() {
  const [newOpen, setNewOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);
  const { data: skills, isLoading } = useSkills();

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
          <div className="py-8 text-center text-sm text-paper-400">Loading…</div>
        ) : !skills?.length ? (
          <div className="py-8 text-center text-sm text-paper-400">
            No skills yet. Create one with the button above.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-600">
                <th className="py-2 text-left text-xs text-paper-500">Name</th>
                <th className="py-2 text-left text-xs text-paper-500">Built-in</th>
                <th className="py-2 text-left text-xs text-paper-500">Description</th>
                <th className="py-2 text-left text-xs text-paper-500">Used by</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr className="border-b border-ink-600 last:border-0" key={skill.id}>
                  <td className="py-2 pr-4 font-medium text-paper-100">{skill.name}</td>
                  <td className="py-2 pr-4">
                    {skill.isBuiltIn && (
                      <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
                        built-in
                      </span>
                    )}
                  </td>
                  <td className="max-w-xs py-2 pr-4">
                    <span className="line-clamp-1 text-paper-400">{skill.description ?? '—'}</span>
                  </td>
                  <td className="py-2 pr-4 tabular-nums text-paper-400">{skill.usedByCount}</td>
                  <td className="py-2 text-right">
                    {!skill.isBuiltIn && (
                      <Button onClick={() => setDeleteTarget(skill)} size="sm" variant="danger">
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <SkillFormModal onClose={() => setNewOpen(false)} open={newOpen} />
      <DeleteConfirmModal onClose={() => setDeleteTarget(null)} skill={deleteTarget} />
    </div>
  );
}
