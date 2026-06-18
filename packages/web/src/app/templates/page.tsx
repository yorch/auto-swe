'use client';

import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Textarea } from '@/components/ui/Textarea';
import { RunTemplateModal } from '@/components/workflow/RunTemplateModal';
import { STARTER_TEMPLATES, type StarterTemplate } from '@/components/workflow/starterTemplates';
import {
  useCreateWorkflowTemplate,
  useUpdateWorkflowTemplate,
  useWorkflowTemplates,
} from '@/hooks/useWorkflows';
import { cn, formatRelativeTime } from '@/lib/utils';
import { useTeamStore } from '@/stores/teamStore';

const SPEC_SCHEMA_VERSION = 1;

const BLANK_SPEC: WorkflowSpec = {
  description: 'Replace this step with your first action.',
  entry: 'start',
  name: 'new-template',
  nodes: {
    done: { status: 'SUCCESS', type: 'terminate' },
    start: { next: 'done', step: 'noop', type: 'step' },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};

const TONE_CLASS: Record<StarterTemplate['tone'], string> = {
  amber: 'border-l-amber-400',
  dust: 'border-l-dust-400',
  ember: 'border-l-ember-400',
  moss: 'border-l-moss-400',
  paper: 'border-l-paper-500',
  violet: 'border-l-violet-400',
};

function CreateTemplateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId);
  const createTemplate = useCreateWorkflowTemplate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    setError(null);
    try {
      const spec: WorkflowSpec = { ...BLANK_SPEC, name: trimmed };
      const result = await createTemplate.mutateAsync({
        description: description.trim() || undefined,
        name: trimmed,
        spec,
        teamId: selectedTeamId ?? undefined,
      });
      const data = (result as { data: { id: string } }).data;
      onClose();
      setName('');
      setDescription('');
      router.push(`/templates/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create failed');
    }
  };

  return (
    <Modal
      eyebrow="§ Templates"
      onClose={() => {
        onClose();
        setName('');
        setDescription('');
        setError(null);
      }}
      open={open}
      title="New template"
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Input
          label="Name"
          onChange={(e) => setName(e.target.value)}
          placeholder="my-workflow"
          value={name}
        />
        <Textarea
          hint="Optional"
          label="Description"
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What does this template do?"
          rows={3}
          value={description}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button
            onClick={() => {
              onClose();
              setName('');
              setDescription('');
              setError(null);
            }}
            variant="secondary"
          >
            Cancel
          </Button>
          <Button disabled={createTemplate.isPending} onClick={handleCreate} variant="primary">
            {createTemplate.isPending ? 'Creating…' : 'Create blank template'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function TemplatesPage() {
  const router = useRouter();
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId);
  const { data: templates, isLoading } = useWorkflowTemplates(selectedTeamId);
  const createTemplate = useCreateWorkflowTemplate();
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<{ id: string; name: string } | null>(null);
  const [runTarget, setRunTarget] = useState<WorkflowTemplateSummary | null>(null);

  const handleFork = async (starter: StarterTemplate) => {
    setForkingId(starter.id);
    setForkError(null);
    try {
      const suffix = Math.random().toString(36).slice(2, 6);
      const name = `${starter.spec.name}-${suffix}`;
      const spec: WorkflowSpec = { ...starter.spec, name };
      const result = await createTemplate.mutateAsync({
        description: starter.spec.description,
        name,
        spec,
        teamId: selectedTeamId ?? undefined,
      });
      const data = (result as { data: { id: string } }).data;
      router.push(`/templates/${data.id}`);
    } catch (err) {
      setForkError(err instanceof Error ? err.message : 'fork failed');
    } finally {
      setForkingId(null);
    }
  };

  return (
    <div className="space-y-12">
      <CreateTemplateModal onClose={() => setCreateOpen(false)} open={createOpen} />

      <ArchiveConfirmModal onClose={() => setArchiveTarget(null)} target={archiveTarget} />

      {runTarget && (
        <RunTemplateModal onClose={() => setRunTarget(null)} open template={runTarget} />
      )}

      <div className="fade-up">
        <PageHeader
          actions={
            <Button onClick={() => setCreateOpen(true)} size="sm" variant="primary">
              + New workflow
            </Button>
          }
          chapter="§ Workflows"
          subtitle="Agentic workflow library. Pick a template, run it with your inputs, watch it execute."
          title="Workflow library."
        />
      </div>

      {/* Starter gallery */}
      <section className="fade-up stagger-1">
        <SectionHeader hint="fork to edit" number="01" title="Start from a template" />
        {forkError && <Alert className="mb-4">{forkError}</Alert>}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {STARTER_TEMPLATES.map((s) => {
            const isForking = forkingId === s.id;
            return (
              <article
                className={cn(
                  'group relative flex flex-col rounded-xl border border-ink-600 bg-ink-800 p-5 transition-colors hover:border-ember-400',
                  'border-l-[3px]',
                  TONE_CLASS[s.tone]
                )}
                key={s.id}
              >
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
                  {s.tagline}
                </div>
                <h3 className="mb-2 font-display text-xl font-medium text-paper-100">{s.name}</h3>
                <p className="mb-5 flex-1 text-sm leading-relaxed text-paper-400">
                  {s.description}
                </p>
                <Button
                  className="self-start"
                  disabled={isForking || createTemplate.isPending}
                  onClick={() => handleFork(s)}
                  size="sm"
                  variant="primary"
                >
                  {isForking ? 'Forking…' : 'Fork starter →'}
                </Button>
              </article>
            );
          })}
        </div>
      </section>

      {/* Existing templates table */}
      <section className="fade-up stagger-2">
        <SectionHeader
          hint={`${(templates ?? []).length} total`}
          number="02"
          title="Existing templates"
        />
        {isLoading ? (
          <LoadingState />
        ) : (
          <Card className="overflow-hidden p-0" variant="inset">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-600">
                  <th className="px-4 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500">
                    Name
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500">
                    Team
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500">
                    Active version
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500">
                    Last run
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500">
                    Updated
                  </th>
                  <th className="px-4 py-3 text-right font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {(templates ?? []).map((t) => (
                  <tr
                    className="border-b border-ink-600 transition-colors hover:bg-ink-700/40"
                    key={t.id}
                  >
                    <td className="px-4 py-3">
                      <Link
                        className="font-medium text-paper-100 hover:text-ember-400"
                        href={`/templates/${t.id}`}
                      >
                        {t.name}
                      </Link>
                      {t.isDefault && (
                        <span className="ml-2 rounded border border-ember-400/40 bg-ember-400/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ember-400">
                          default
                        </span>
                      )}
                      {t.description && (
                        <div className="text-xs text-paper-500">{t.description}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-paper-400">
                      {t.team?.name ?? <em className="text-paper-500">global</em>}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-paper-300">
                      {t.activeVersion !== null ? `v${t.activeVersion}` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {t.lastRun ? (
                        <Link
                          className="inline-flex items-center gap-2"
                          href={`/runs/${t.lastRun.id}`}
                        >
                          <StatusBadge status={t.lastRun.status} />
                          <span className="font-mono text-[11px] text-paper-500">
                            {formatRelativeTime(t.lastRun.startedAt)}
                          </span>
                        </Link>
                      ) : (
                        <span className="font-mono text-[11px] uppercase tracking-wider text-paper-500">
                          never
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-paper-500">
                      {formatRelativeTime(t.updatedAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {t.status === 'ACTIVE' && t.activeVersion !== null && (
                          <Button onClick={() => setRunTarget(t)} size="sm" variant="primary">
                            Run →
                          </Button>
                        )}
                        <Button
                          onClick={() => router.push(`/templates/${t.id}`)}
                          size="sm"
                          variant="secondary"
                        >
                          Edit
                        </Button>
                        {t.status !== 'ARCHIVED' && (
                          <Button
                            onClick={() => setArchiveTarget({ id: t.id, name: t.name })}
                            size="sm"
                            variant="danger"
                          >
                            Archive
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {(templates ?? []).length === 0 && (
                  <tr>
                    <td
                      className="px-4 py-8 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500"
                      colSpan={7}
                    >
                      no templates yet — fork a starter above or create a blank template
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </div>
  );
}

function ArchiveConfirmModal({
  target,
  onClose,
}: {
  target: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const updateTemplate = useUpdateWorkflowTemplate(target?.id ?? '');

  const handleArchive = async () => {
    if (!target) {
      return;
    }
    await updateTemplate.mutateAsync({ status: 'ARCHIVED' });
    onClose();
  };

  return (
    <ConfirmModal
      confirmLabel="Archive"
      message={`Archive "${target?.name ?? ''}"? It will no longer be available for new runs. You can restore it by changing its status back to Active.`}
      onClose={onClose}
      onConfirm={handleArchive}
      open={target !== null}
      title="Archive template"
    />
  );
}
