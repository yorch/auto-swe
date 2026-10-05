'use client';

import { isSystemManagedTemplate } from '@auto-swe/shared/lib/channelTask';
import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { SparkleIcon } from '@/components/ui/icons';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { Textarea } from '@/components/ui/Textarea';
import { STARTER_TEMPLATES, type StarterTemplate } from '@/components/workflow/starterTemplates';
import { VersionTags } from '@/components/workflow/VersionTags';
import { useHasRole } from '@/hooks/useHasRole';
import { useLedTeamIds } from '@/hooks/useTeams';
import {
  useCreateWorkflowTemplate,
  useStartWorkflowGenerationJob,
  useUpdateWorkflowTemplate,
  useWorkflowGenerationJob,
  useWorkflowTemplates,
} from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';
import { requestHref } from '@/lib/requestDisplay';
import { requiresRoleTitle } from '@/lib/roles';
import { canWriteTeamResource } from '@/lib/teamPermissions';
import { cn, formatRelativeTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { useTeamStore } from '@/stores/teamStore';
import { restoreTemplate } from './restoreTemplate';

const SPEC_SCHEMA_VERSION = 1;

const BLANK_SPEC: WorkflowSpec = {
  description: 'Replace this step with your first action.',
  entry: 'start',
  name: 'new-workflow',
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

type StatusFilter = 'current' | 'active' | 'draft' | 'archived';

function matchesStatusFilter(t: WorkflowTemplateSummary, filter: StatusFilter): boolean {
  switch (filter) {
    case 'active':
      return t.status === 'ACTIVE';
    case 'draft':
      return t.status === 'DRAFT';
    case 'archived':
      return t.status === 'ARCHIVED';
    default:
      return t.status !== 'ARCHIVED';
  }
}

/** Brings an archived template back: active when it has an active version, otherwise a draft. */
function RestoreButton({
  template,
  onError,
}: {
  template: WorkflowTemplateSummary;
  onError: (message: string | null) => void;
}) {
  const update = useUpdateWorkflowTemplate(template.id);
  return (
    <Button
      aria-label={`Restore ${template.name}`}
      disabled={update.isPending}
      onClick={async () => {
        onError(null);
        try {
          await restoreTemplate(template.activeVersion, (status) => update.mutateAsync({ status }));
        } catch (err) {
          onError(`Could not restore "${template.name}": ${errMsg(err, 'restore failed')}`);
        }
      }}
      size="sm"
      variant="secondary"
    >
      {update.isPending ? 'Restoring…' : 'Restore'}
    </Button>
  );
}

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
      router.push(`/workflows/library/${data.id}`);
    } catch (err) {
      setError(errMsg(err, 'create failed'));
    }
  };

  return (
    <Modal
      eyebrow="§ Workflows"
      onClose={() => {
        onClose();
        setName('');
        setDescription('');
        setError(null);
      }}
      open={open}
      title="New workflow"
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
          placeholder="What does this workflow do?"
          rows={3}
          value={description}
        />
        <ModalFooter
          isPending={createTemplate.isPending}
          onCancel={() => {
            onClose();
            setName('');
            setDescription('');
            setError(null);
          }}
          onSubmit={handleCreate}
          pendingLabel="Creating…"
          submitLabel="Create blank workflow"
        />
      </div>
    </Modal>
  );
}

const JOB_PHASE_LABEL: Record<string, string> = {
  done: 'Finishing…',
  generating: 'Designing the workflow…',
  persisting: 'Saving the draft…',
};

function NewTemplateModal({
  open,
  onClose,
  onStartBlank,
}: {
  open: boolean;
  onClose: () => void;
  onStartBlank: () => void;
}) {
  const router = useRouter();
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId);
  const startJob = useStartWorkflowGenerationJob();
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [mode, setMode] = useState<'describe' | 'wizard'>('describe');

  // Wizard fields: the answers are assembled into a single prompt for the
  // workflow author, so no backend changes are needed.
  const [goal, setGoal] = useState('');
  const [inputs, setInputs] = useState('');
  const [steps, setSteps] = useState('');
  const [outcome, setOutcome] = useState('');

  // Poll the async generation job while one is in flight.
  const { data: job } = useWorkflowGenerationJob(jobId);

  const reset = () => {
    setPrompt('');
    setName('');
    setError(null);
    setJobId(null);
    setMode('describe');
    setGoal('');
    setInputs('');
    setSteps('');
    setOutcome('');
  };

  // React to terminal job states: route to the canvas on success, surface the
  // message on failure. (Polling is non-blocking, so no proxy idle-timeout.)
  useEffect(() => {
    if (!job) {
      return;
    }
    if (job.status === 'done') {
      const id = job.templateId;
      // Clear local state inline (setters are stable, so they stay out of deps)
      // and route to the canvas for the new DRAFT.
      setPrompt('');
      setName('');
      setError(null);
      setJobId(null);
      onClose();
      router.push(`/workflows/library/${id}`);
    } else if (job.status === 'failed') {
      setError(job.message);
      setJobId(null);
    }
  }, [job, onClose, router]);

  const buildWizardPrompt = () => {
    const parts = [
      'Create an agentic workflow.',
      goal.trim() ? `Goal: ${goal.trim()}` : '',
      inputs.trim() ? `Input it receives: ${inputs.trim()}` : '',
      steps.trim() ? `Steps to perform: ${steps.trim()}` : '',
      outcome.trim() ? `Expected outcome: ${outcome.trim()}` : '',
    ];
    return parts.filter(Boolean).join('\n');
  };

  const handleGenerate = async (forcedPrompt?: string) => {
    const effectivePrompt = (
      forcedPrompt ?? (mode === 'wizard' ? buildWizardPrompt() : prompt)
    ).trim();
    if (!effectivePrompt) {
      setError(
        mode === 'wizard'
          ? 'Fill in at least one wizard field'
          : 'Describe what the workflow should do'
      );
      return;
    }
    setError(null);
    try {
      const result = await startJob.mutateAsync({
        name: name.trim() || undefined,
        prompt: effectivePrompt,
        teamId: selectedTeamId ?? undefined,
      });
      setJobId(result.jobId);
    } catch (err) {
      setError(errMsg(err, 'generation failed'));
    }
  };

  // Busy while a job is in flight — including the brief window where a transient
  // poll error leaves `job` undefined — so the button can't re-enable and let the
  // user start a second (duplicate, billed) generation. The terminal-state effect
  // clears `jobId`, which ends "busy".
  const busy =
    startJob.isPending || (jobId !== null && job?.status !== 'done' && job?.status !== 'failed');
  const phaseLabel =
    job?.status === 'running' ? (JOB_PHASE_LABEL[job.phase ?? 'generating'] ?? 'Working…') : null;

  return (
    <Modal
      eyebrow="§ Workflows"
      onClose={() => {
        onClose();
        reset();
      }}
      open={open}
      title="New workflow"
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <SegmentedControl
          ariaLabel="How to describe the workflow"
          onChange={setMode}
          options={[
            { label: 'Describe', value: 'describe' },
            { label: 'Answer questions', value: 'wizard' },
          ]}
          value={mode}
        />
        {mode === 'describe' ? (
          <p className="text-sm leading-relaxed text-paper-400">
            Describe what you want the workflow to do in plain language. An AI agent assembles a
            workflow from your available steps, agents, and connections, and saves it as a{' '}
            <span className="font-mono text-paper-300">DRAFT</span> for you to review and edit on
            the canvas before activating.
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-paper-400">
            Answer a few questions and the AI will assemble a draft workflow from your answers. You
            can refine it on the canvas before activating.
          </p>
        )}
        {mode === 'describe' ? (
          <Textarea
            disabled={busy}
            label="Description"
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. When a request comes in, plan the work, run the right agents, and produce a validated outcome. Pause for human approval before finalizing."
            rows={6}
            value={prompt}
          />
        ) : (
          <div className="space-y-3">
            <Textarea
              disabled={busy}
              hint="What should the workflow accomplish?"
              label="Goal"
              onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g. Summarize a support ticket and draft a reply for the responder to review."
              rows={2}
              value={goal}
            />
            <Textarea
              disabled={busy}
              hint="Optional"
              label="Input"
              onChange={(e) => setInputs(e.target.value)}
              placeholder="e.g. A Zendesk ticket number and the customer's last message."
              rows={2}
              value={inputs}
            />
            <Textarea
              disabled={busy}
              hint="Optional"
              label="Steps"
              onChange={(e) => setSteps(e.target.value)}
              placeholder="e.g. Fetch the ticket, classify the issue, retrieve related KB articles, draft a response."
              rows={2}
              value={steps}
            />
            <Textarea
              disabled={busy}
              hint="Optional"
              label="Outcome"
              onChange={(e) => setOutcome(e.target.value)}
              placeholder="e.g. A support reply saved as a draft on the ticket, waiting for human send."
              rows={2}
              value={outcome}
            />
          </div>
        )}
        <Input
          disabled={busy}
          hint="Optional — defaults to a name the AI picks"
          label="Name"
          onChange={(e) => setName(e.target.value)}
          placeholder="my-workflow"
          value={name}
        />
        <ModalFooter
          isPending={busy}
          onCancel={() => {
            onClose();
            reset();
          }}
          onSubmit={() => handleGenerate()}
          pendingLabel="Generating…"
          submitLabel="Generate draft"
        >
          {phaseLabel && <span className="label-mono">{phaseLabel}</span>}
        </ModalFooter>
        <div className="flex justify-end pt-1">
          <Button
            disabled={busy}
            onClick={() => {
              onClose();
              reset();
              onStartBlank();
            }}
            size="sm"
            variant="ghost"
          >
            Or start from a blank workflow
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function TemplatesPage() {
  const router = useRouter();
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId);
  const {
    data: templates,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useWorkflowTemplates(selectedTeamId);
  const createTemplate = useCreateWorkflowTemplate();
  // Creating, forking and archiving templates are LEAD routes on the gateway,
  // and on top of the platform role the gateway requires LEAD membership on the
  // owning team (templateWriteFilter); a GLOBAL template is ADMIN-only. New
  // templates are created for the selected team, so creation needs a team the
  // caller leads selected (or platform ADMIN).
  const platformRole = useAuthStore((s) => s.user?.role);
  const isLead = useHasRole('LEAD');
  const ledTeamIds = useLedTeamIds();
  const canWrite = (teamId: string | null | undefined) =>
    canWriteTeamResource(platformRole, teamId, ledTeamIds);
  const canManage = canWrite(selectedTeamId);
  const manageTitle = canManage
    ? undefined
    : isLead
      ? 'Select a team you lead to author workflows for it'
      : requiresRoleTitle('LEAD');
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<{ id: string; name: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('current');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // The built-in Channel Assistant template only records channel conversations: the platform
  // starts it, so it is shown but cannot be run or archived by hand.
  const isSystemManaged = (t: WorkflowTemplateSummary) => isSystemManagedTemplate(t);
  const visibleTemplates = (templates ?? []).filter((t) => matchesStatusFilter(t, statusFilter));

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
      router.push(`/workflows/library/${data.id}`);
    } catch (err) {
      setForkError(errMsg(err, 'fork failed'));
    } finally {
      setForkingId(null);
    }
  };

  return (
    <div className="space-y-8">
      <CreateTemplateModal onClose={() => setCreateOpen(false)} open={createOpen} />

      <NewTemplateModal
        onClose={() => setGenerateOpen(false)}
        onStartBlank={() => {
          setGenerateOpen(false);
          setCreateOpen(true);
        }}
        open={generateOpen}
      />

      <ArchiveConfirmModal onClose={() => setArchiveTarget(null)} target={archiveTarget} />

      <PageHeader
        actions={
          <span title={manageTitle}>
            <Button
              aria-describedby={manageTitle ? 'manage-reason' : undefined}
              disabled={!canManage}
              onClick={() => setGenerateOpen(true)}
              size="sm"
              variant="primary"
            >
              <SparkleIcon />
              New workflow
            </Button>
          </span>
        }
        subtitle="Your reusable workflows. Pick one, run it with your inputs, and follow the request."
        title="Workflow library"
      />

      {manageTitle && (
        <p className="-mt-4 text-xs text-paper-500" id="manage-reason">
          {manageTitle}.
        </p>
      )}

      {/* Workflows table */}
      <section>
        <SectionHeader
          actions={
            <SegmentedControl
              ariaLabel="Filter workflows by status"
              onChange={setStatusFilter}
              options={[
                { label: 'Active & drafts', value: 'current' },
                { label: 'Active', value: 'active' },
                { label: 'Drafts', value: 'draft' },
                { label: 'Archived', value: 'archived' },
              ]}
              value={statusFilter}
            />
          }
          hint={`${visibleTemplates.length} shown`}
          number="01"
          title="Your workflows"
        />
        {restoreError && <Alert className="mb-4">{restoreError}</Alert>}
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="workflows"
          onRetry={() => void refetch()}
        >
          {
            <Card className="overflow-hidden p-0" variant="inset">
              <Table stacked>
                <THead>
                  <Th>Name</Th>
                  <Th>Team</Th>
                  <Th>Status</Th>
                  <Th>Active version</Th>
                  <Th>Last run</Th>
                  <Th>Updated</Th>
                  <Th align="right">Actions</Th>
                </THead>
                <tbody>
                  {visibleTemplates.map((t) => (
                    <TRow className="hover:bg-ink-700/40" hover key={t.id}>
                      <Td className="px-4 py-3" primary>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Link
                            className="font-medium text-paper-100 hover:text-ember-400"
                            href={`/workflows/library/${t.id}`}
                          >
                            {t.name}
                          </Link>
                          <VersionTags isDefault={t.isDefault} />
                          {isSystemManaged(t) && (
                            <Badge tone="neutral" variant="outline">
                              Used by channel assistants
                            </Badge>
                          )}
                          {t.webhookConfigured && (
                            <Badge
                              title="Webhook trigger active"
                              tone="violet"
                              uppercase
                              variant="outline"
                            >
                              webhook
                            </Badge>
                          )}
                        </div>
                        {t.description && (
                          <div
                            className="line-clamp-2 max-w-md text-xs text-paper-500"
                            title={t.description}
                          >
                            {t.description}
                          </div>
                        )}
                      </Td>
                      <Td className="px-4 py-3 whitespace-nowrap text-paper-400" label="Team">
                        {t.team?.name ?? <span className="text-paper-500">Platform-wide</span>}
                      </Td>
                      <Td className="px-4 py-3" label="Status">
                        <StatusBadge status={t.status} />
                      </Td>
                      <Td
                        className="px-4 py-3 font-mono text-xs text-paper-300"
                        label="Active version"
                      >
                        {t.activeVersion !== null ? `v${t.activeVersion}` : '—'}
                      </Td>
                      <Td className="px-4 py-3" label="Last run">
                        {t.lastRun ? (
                          <Link
                            className="inline-flex items-center gap-2"
                            href={
                              t.lastRun.workRequestId
                                ? requestHref(t.lastRun.workRequestId)
                                : `/runs/${t.lastRun.id}`
                            }
                          >
                            <StatusBadge status={t.lastRun.status} />
                            <span className="font-mono text-[11px] text-paper-500">
                              {formatRelativeTime(t.lastRun.startedAt)}
                            </span>
                          </Link>
                        ) : (
                          <span className="text-xs text-paper-500">Never</span>
                        )}
                      </Td>
                      <Td
                        className="px-4 py-3 font-mono text-[11px] text-paper-500"
                        label="Updated"
                      >
                        {formatRelativeTime(t.updatedAt)}
                      </Td>
                      <Td className="px-4 py-3 text-right">
                        <div className="flex flex-wrap items-center justify-end gap-2 max-sm:justify-start">
                          {t.status === 'ARCHIVED' || isSystemManaged(t) ? null : t.status ===
                              'ACTIVE' && t.activeVersion !== null ? (
                            <ButtonLink
                              className="whitespace-nowrap"
                              href={`/start?template=${encodeURIComponent(t.id)}`}
                              size="sm"
                              variant="primary"
                            >
                              Run →
                            </ButtonLink>
                          ) : (
                            <span className="flex cursor-not-allowed items-center gap-2">
                              <span
                                className="text-[11px] text-paper-500"
                                id={`run-reason-${t.id}`}
                              >
                                {t.status === 'DRAFT'
                                  ? 'Activate it to run'
                                  : 'Promote a version to run'}
                              </span>
                              <Button
                                aria-describedby={`run-reason-${t.id}`}
                                disabled
                                size="sm"
                                variant="ghost"
                              >
                                Run
                              </Button>
                            </span>
                          )}
                          <ButtonLink
                            href={`/workflows/library/${t.id}`}
                            size="sm"
                            variant="secondary"
                          >
                            {canWrite(t.team?.id) && !isSystemManaged(t) ? 'Edit' : 'View'}
                          </ButtonLink>
                          {canWrite(t.team?.id) && t.status === 'ARCHIVED' && (
                            <RestoreButton onError={setRestoreError} template={t} />
                          )}
                          {canWrite(t.team?.id) &&
                            t.status !== 'ARCHIVED' &&
                            !isSystemManaged(t) && (
                              <Button
                                className="text-brick-400 hover:text-brick-400"
                                onClick={() => setArchiveTarget({ id: t.id, name: t.name })}
                                size="sm"
                                variant="ghost"
                              >
                                Archive
                              </Button>
                            )}
                        </div>
                      </Td>
                    </TRow>
                  ))}
                  {visibleTemplates.length === 0 && (
                    <TableStatusRow colSpan={7}>
                      <EmptyState
                        hint={
                          (templates ?? []).length === 0
                            ? 'Fork a starter below or create a blank workflow.'
                            : 'Try another status filter.'
                        }
                        title={
                          (templates ?? []).length === 0
                            ? 'No workflows yet'
                            : 'No workflows with this status.'
                        }
                      />
                    </TableStatusRow>
                  )}
                </tbody>
              </Table>
            </Card>
          }
        </QueryBoundary>
      </section>
      {/* Starter gallery */}
      <details className="rounded-lg border border-ink-600 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-paper-100">
          New workflow from a starter
          <span className="ml-2 text-xs font-normal text-paper-400">
            Fork one to edit it as your own
          </span>
        </summary>
        {forkError && <Alert className="mb-4 mt-4">{forkError}</Alert>}
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {STARTER_TEMPLATES.map((s) => {
            const isForking = forkingId === s.id;
            return (
              <Card
                className={cn(
                  'group flex flex-col p-5 hover:border-ember-400',
                  'border-l-[3px]',
                  TONE_CLASS[s.tone]
                )}
                key={s.id}
              >
                <div className="label-mono mb-2">{s.tagline}</div>
                <h3 className="mb-2 font-display text-xl font-medium text-paper-100">{s.name}</h3>
                <p className="mb-5 flex-1 text-sm leading-relaxed text-paper-400">
                  {s.description}
                </p>
                <span className="self-start" title={manageTitle}>
                  <Button
                    aria-describedby={manageTitle ? 'manage-reason' : undefined}
                    disabled={!canManage || isForking || createTemplate.isPending}
                    onClick={() => handleFork(s)}
                    size="sm"
                    variant="primary"
                  >
                    {isForking ? 'Forking…' : 'Fork starter'}
                  </Button>
                </span>
              </Card>
            );
          })}
        </div>
      </details>
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
    // ConfirmModal closes itself once this resolves.
    await updateTemplate.mutateAsync({ status: 'ARCHIVED' });
  };

  return (
    <ConfirmModal
      confirmLabel="Archive"
      dangerous
      message={`Archive "${target?.name ?? ''}"? It will no longer be available for new runs. You can restore it later from the Archived filter.`}
      onClose={onClose}
      onConfirm={handleArchive}
      open={target !== null}
      title="Archive workflow?"
    />
  );
}
