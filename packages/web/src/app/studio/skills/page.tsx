'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  type Skill,
  useCreateSkill,
  useDeleteSkill,
  useSkillEffectiveness,
  useSkills,
  useUpdateSkill,
} from '@/hooks/useSkills';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';

function pct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(0)}%`;
}

function OriginBadge({ origin }: { origin: string | null }) {
  if (!origin) {
    return null;
  }
  return (
    <Badge className="ml-1.5" tone="neutral">
      {origin}
    </Badge>
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

  const sk = skill;

  function startEdit() {
    setForm({
      description: sk.description ?? '',
      isActive: sk.isActive,
      name: sk.name,
      promptText: sk.promptText,
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
      const patch: Parameters<typeof update.mutateAsync>[0] = { id: sk.id };
      if (form.name !== sk.name) {
        patch.name = form.name;
      }
      if (form.description !== (sk.description ?? '')) {
        patch.description = form.description;
      }
      if (form.isActive !== sk.isActive) {
        patch.isActive = form.isActive;
      }
      if (!sk.isBuiltIn && form.promptText !== sk.promptText) {
        patch.promptText = form.promptText;
      }
      await update.mutateAsync(patch);
      setEditing(false);
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Failed to save skill'));
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
              <pre className="w-full rounded-[9px] border border-ink-500 bg-ink-800 px-3 py-2 text-xs text-paper-400 whitespace-pre-wrap break-words">
                {skill.promptText}
              </pre>
            ) : (
              <textarea
                className="w-full rounded-[9px] border border-ink-500 bg-ink-800 px-3 py-2 font-mono text-xs text-paper-100 placeholder-paper-500 focus:border-ember-400 focus:outline-none"
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
            <ToggleSwitch
              checked={form.isActive}
              label={form.isActive ? 'Enabled' : 'Disabled'}
              onChange={() => setForm((f) => ({ ...f, isActive: !f.isActive }))}
            />
          </FieldWrapper>
          {error && <Alert variant="error">{error}</Alert>}
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
              <span className="rounded bg-moss-400/15 px-2 py-0.5 font-mono text-moss-400">
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
            <pre className="max-h-96 overflow-auto rounded-[9px] border border-ink-600 bg-ink-800 p-3 text-xs text-paper-200 whitespace-pre-wrap break-words">
              {skill.promptText}
            </pre>
          </div>
          <div className="flex items-center justify-between border-t border-ink-700 pt-4">
            <div className="space-y-0.5 text-xs text-paper-500">
              <div>Created {formatDate(skill.createdAt)}</div>
              <div>Updated {formatDate(skill.updatedAt)}</div>
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
      setError(errMsg(err, 'Failed to create skill'));
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
            className="w-full rounded-[9px] border border-ink-500 bg-ink-800 px-3 py-2 font-mono text-xs text-paper-100 placeholder-paper-500 focus:border-ember-400 focus:outline-none"
            onChange={(e) => setForm((f) => ({ ...f, promptText: e.target.value }))}
            required
            rows={8}
            value={form.promptText}
          />
        </FieldWrapper>
        {error && <Alert variant="error">{error}</Alert>}
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

// ── Effectiveness Card ────────────────────────────────────────────────────────

function EffectivenessCard() {
  const { data, isLoading, isError, error: loadError } = useSkillEffectiveness();
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
      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="skill effectiveness"
      >
        {!data?.perSkill.length ? (
          <EmptyState className="py-6" title="No runs with active skills in this window yet." />
        ) : (
          <Table>
            <THead>
              <Th variant="compact">Skill</Th>
              <Th align="right" variant="compact">
                Runs
              </Th>
              <Th align="right" variant="compact">
                Success rate
              </Th>
              <Th align="right" variant="compact">
                Avg cost
              </Th>
            </THead>
            <tbody>
              {data.perSkill.map((s) => (
                <TRow key={s.name}>
                  <Td className="py-2 pr-4 font-medium text-paper-100">{s.name}</Td>
                  <Td className="py-2 text-right tabular-nums text-paper-400">{s.runs}</Td>
                  <Td className="py-2 text-right tabular-nums text-paper-400">
                    {pct(s.successRate)}
                  </Td>
                  <Td className="py-2 text-right tabular-nums text-paper-400">
                    {s.avgCostUsd == null ? '—' : `$${s.avgCostUsd.toFixed(2)}`}
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </QueryBoundary>
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function StudioSkillsPage() {
  const [newOpen, setNewOpen] = useState(false);
  const [viewTarget, setViewTarget] = useState<Skill | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);
  const deleteSkill = useDeleteSkill();
  const { data: skills, isLoading, isError, error: loadError } = useSkills();
  const update = useUpdateSkill();

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            + New Skill
          </Button>
        }
        subtitle="Reusable prompt-fragment instructions injected into an agent's system prompt. Assigned to agent roles at any scope. Tool access control is managed separately via Agent Tool Access."
        title="Skill Library"
      />

      <Card>
        <CardHeader>
          <CardTitle>All Skills</CardTitle>
        </CardHeader>
        <QueryBoundary error={loadError} isError={isError} isLoading={isLoading} label="skills">
          {!skills?.length ? (
            <EmptyState title="No skills yet. Create one with the button above." />
          ) : (
            <Table>
              <THead>
                <Th variant="compact">Name</Th>
                <Th variant="compact">Description</Th>
                <Th variant="compact">Used by</Th>
                <Th variant="compact">Active</Th>
                <Th variant="compact" />
              </THead>
              <tbody>
                {skills.map((skill) => (
                  <TRow key={skill.id}>
                    <Td className="py-2 pr-4">
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
                          <span className="font-mono text-[10px] text-moss-400">verified</span>
                        )}
                        {!skill.isVerified && !skill.isBuiltIn && (
                          <span className="font-mono text-[10px] text-amber-400">unverified</span>
                        )}
                      </div>
                    </Td>
                    <Td className="max-w-xs py-2 pr-4">
                      <span className="line-clamp-1 text-paper-400">
                        {skill.description ?? '—'}
                      </span>
                    </Td>
                    <Td className="py-2 pr-4 tabular-nums text-paper-400">{skill.usedByCount}</Td>
                    <Td className="py-2 pr-4">
                      <ToggleSwitch
                        checked={skill.isActive}
                        disabled={update.isPending}
                        onChange={() => update.mutate({ id: skill.id, isActive: !skill.isActive })}
                      />
                    </Td>
                    <Td className="py-2 text-right">
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
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </QueryBoundary>
      </Card>

      <EffectivenessCard />

      <SkillFormModal onClose={() => setNewOpen(false)} open={newOpen} />
      <SkillDetailModal onClose={() => setViewTarget(null)} skill={viewTarget} />
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message="This will remove the skill and all its assignments. This cannot be undone."
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await deleteSkill.mutateAsync(deleteTarget.id);
          }
        }}
        open={deleteTarget !== null}
        pendingLabel="Deleting…"
        title={`Delete "${deleteTarget?.name ?? ''}"?`}
      />
    </div>
  );
}
