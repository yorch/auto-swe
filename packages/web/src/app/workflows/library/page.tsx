'use client';

import { isSystemManagedTemplate } from '@auto-swe/shared/lib/channelTask';
import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SparkleIcon } from '@/components/ui/icons';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
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
import { cn, FOCUS_RING, formatDate, formatRelativeTime } from '@/lib/utils';
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
            <span className="font-medium text-paper-300">draft</span> for you to review and edit on
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
          {phaseLabel && (
            <span aria-live="polite" className="text-xs text-paper-400">
              {phaseLabel}
            </span>
          )}
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

const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  active: 'Active',
  archived: 'Archived',
  current: 'Active & drafts',
  draft: 'Drafts',
};

function matchesSearch(t: WorkflowTemplateSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return [t.name, t.description ?? '', t.team?.name ?? 'platform-wide'].some((v) =>
    v.toLowerCase().includes(q)
  );
}

/**
 * The visible primary action of a row: Run for a runnable workflow, otherwise
 * a disabled Run that says why (the reason is read out, not only shown on hover).
 */
function RunAction({ template }: { template: WorkflowTemplateSummary }) {
  if (template.status === 'ARCHIVED' || isSystemManagedTemplate(template)) {
    return null;
  }
  if (template.status === 'ACTIVE' && template.activeVersion !== null) {
    return (
      <ButtonLink
        aria-label={`Run ${template.name}`}
        href={`/start?template=${encodeURIComponent(template.id)}`}
        size="sm"
        variant="primary"
      >
        Run
        <Icon name="arrowRight" size={13} />
      </ButtonLink>
    );
  }
  const reason = template.status === 'DRAFT' ? 'Activate it to run' : 'Promote a version to run';
  return (
    <span className="inline-flex cursor-not-allowed" title={reason}>
      <Button aria-describedby={`run-reason-${template.id}`} disabled size="sm" variant="secondary">
        Run
      </Button>
      <span className="sr-only" id={`run-reason-${template.id}`}>
        {reason}
      </span>
    </span>
  );
}

function TemplateRow({
  canWrite,
  onArchive,
  onError,
  template: t,
}: {
  canWrite: boolean;
  onArchive: (target: { id: string; name: string }) => void;
  onError: (message: string | null) => void;
  template: WorkflowTemplateSummary;
}) {
  // Restoring brings an archived template back: active when it has an active
  // version, otherwise a draft.
  const update = useUpdateWorkflowTemplate(t.id);
  const systemManaged = isSystemManagedTemplate(t);
  const href = `/workflows/library/${t.id}`;
  const restore = async () => {
    onError(null);
    try {
      await restoreTemplate(t.activeVersion, (status) => update.mutateAsync({ status }));
    } catch (err) {
      onError(`Could not restore "${t.name}": ${errMsg(err, 'restore failed')}`);
    }
  };

  const menuItems: ActionMenuItem[] = [
    {
      href,
      icon: canWrite && !systemManaged ? 'edit' : 'canvas',
      id: 'open',
      label: canWrite && !systemManaged ? 'Edit' : 'View',
    },
    { href: `${href}/analytics`, icon: 'analytics', id: 'analytics', label: 'Analytics' },
    { href: `${href}/runs`, icon: 'runs', id: 'runs', label: 'Run history' },
  ];
  if (canWrite && t.status === 'ARCHIVED') {
    menuItems.push({
      disabled: update.isPending,
      icon: 'refresh',
      id: 'restore',
      label: update.isPending ? 'Restoring…' : 'Restore',
      onAction: () => void restore(),
    });
  }
  if (canWrite && t.status !== 'ARCHIVED' && !systemManaged) {
    menuItems.push({
      icon: 'trash',
      id: 'archive',
      label: 'Archive',
      onAction: () => onArchive({ id: t.id, name: t.name }),
      tone: 'danger',
    });
  }

  return (
    <TRow hover>
      <Td className="py-3 pr-4 pl-4 sm:pl-5" primary>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Link
            className={cn('rounded-sm font-medium text-paper-100 hover:text-ember-400', FOCUS_RING)}
            href={href}
          >
            {t.name}
          </Link>
          <VersionTags isDefault={t.isDefault} />
          {systemManaged && (
            <Badge title="Started by the platform; it cannot be run by hand" tone="neutral">
              Used by channel assistants
            </Badge>
          )}
          {t.webhookConfigured && (
            <Badge title="A webhook URL can start this workflow" tone="violet" variant="outline">
              Webhook
            </Badge>
          )}
        </div>
        {t.description && (
          <p
            className="mt-0.5 line-clamp-1 max-w-xl text-[13px] font-normal text-paper-500 max-sm:line-clamp-2"
            title={t.description}
          >
            {t.description}
          </p>
        )}
      </Td>
      <Td className="px-4 py-3 whitespace-nowrap text-[13px] text-paper-300" label="Team">
        {t.team?.name ?? <span className="text-paper-500">Platform-wide</span>}
      </Td>
      <Td className="px-4 py-3" label="Status">
        <StatusBadge status={t.status} />
      </Td>
      <Td className="px-4 py-3 text-[13px] text-paper-300" label="Version">
        {t.activeVersion !== null ? (
          <span className="tabular-nums">v{t.activeVersion}</span>
        ) : (
          <span className="text-paper-500">—</span>
        )}
      </Td>
      <Td className="px-4 py-3" label="Last run">
        {t.lastRun ? (
          <Link
            className={cn('inline-flex items-center gap-2 rounded-sm', FOCUS_RING)}
            href={
              t.lastRun.workRequestId
                ? requestHref(t.lastRun.workRequestId)
                : `/runs/${t.lastRun.id}`
            }
            title={formatDate(t.lastRun.startedAt)}
          >
            <StatusBadge status={t.lastRun.status} />
            <span className="text-xs text-paper-500 tabular-nums">
              {formatRelativeTime(t.lastRun.startedAt)}
            </span>
          </Link>
        ) : (
          <span className="text-[13px] text-paper-500">Never</span>
        )}
      </Td>
      <Td
        className="px-4 py-3 whitespace-nowrap text-[13px] text-paper-500 tabular-nums"
        label="Updated"
        title={formatDate(t.updatedAt)}
      >
        {formatRelativeTime(t.updatedAt)}
      </Td>
      <Td align="right" className="py-3 pr-3 pl-4 sm:pr-4">
        <div className="flex items-center justify-end gap-1.5 max-sm:justify-start">
          <RunAction template={t} />
          <ActionMenu items={menuItems} label={`More actions for ${t.name}`} />
        </div>
      </Td>
    </TRow>
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
  const [search, setSearch] = useState('');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const all = templates ?? [];
  const inStatus = all.filter((t) => matchesStatusFilter(t, statusFilter));
  const visibleTemplates = inStatus.filter((t) => matchesSearch(t, search));
  const searching = search.trim() !== '';
  const statusCount = (f: StatusFilter) => all.filter((t) => matchesStatusFilter(t, f)).length;

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

  const newWorkflowButton = (
    <span title={manageTitle}>
      <Button
        aria-describedby={manageTitle ? 'manage-reason' : undefined}
        disabled={!canManage}
        onClick={() => setGenerateOpen(true)}
        variant="primary"
      >
        <SparkleIcon />
        New workflow
      </Button>
    </span>
  );

  return (
    <div className="space-y-6">
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
        actions={newWorkflowButton}
        subtitle={
          <>
            Your reusable workflows. Pick one, run it with your inputs, and follow the request.
            {manageTitle && (
              <span className="mt-1 block text-xs text-paper-500" id="manage-reason">
                {manageTitle}.
              </span>
            )}
          </>
        }
        title="Workflow library"
      />

      {restoreError && <Alert>{restoreError}</Alert>}

      <Card className="p-0">
        <Toolbar
          className="mb-0 border-b border-ink-600 px-4 py-3 sm:px-5"
          end={
            all.length > 0 ? (
              <span className="text-xs text-paper-500 tabular-nums">
                {visibleTemplates.length === all.length
                  ? `${all.length} workflows`
                  : `${visibleTemplates.length} of ${all.length} workflows`}
              </span>
            ) : null
          }
        >
          <SearchInput
            label="Search workflows"
            onChange={setSearch}
            placeholder="Search workflows…"
            value={search}
          />
          <SegmentedControl
            ariaLabel="Filter workflows by status"
            onChange={setStatusFilter}
            options={(['current', 'active', 'draft', 'archived'] as const).map((f) => ({
              label: templates ? (
                <>
                  {STATUS_FILTER_LABEL[f]}
                  <span className="ml-1.5 text-paper-500 tabular-nums">{statusCount(f)}</span>
                </>
              ) : (
                STATUS_FILTER_LABEL[f]
              ),
              value: f,
            }))}
            value={statusFilter}
          />
        </Toolbar>
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="workflows"
          loading={<SkeletonRows className="px-5 py-4" rows={8} />}
          onRetry={() => void refetch()}
        >
          {visibleTemplates.length === 0 ? (
            all.length === 0 ? (
              <EmptyState
                action={newWorkflowButton}
                hint="Describe a workflow and let AI draft it, or fork one of the starters below."
                icon="workflows"
                title="No workflows yet"
              />
            ) : searching ? (
              <EmptyState
                action={
                  <Button onClick={() => setSearch('')} size="sm">
                    Clear search
                  </Button>
                }
                hint={`Nothing in “${STATUS_FILTER_LABEL[statusFilter]}” matches “${search.trim()}”.`}
                icon="search"
                title="No matching workflows"
              />
            ) : (
              <EmptyState
                action={
                  statusFilter !== 'current' && (
                    <Button onClick={() => setStatusFilter('current')} size="sm">
                      Show active & drafts
                    </Button>
                  )
                }
                hint="Try another status filter."
                icon="filter"
                title={`No ${STATUS_FILTER_LABEL[statusFilter].toLowerCase()} workflows`}
              />
            )
          ) : (
            <Table className="max-sm:p-3" stacked>
              <THead>
                <Th className="pl-4 sm:pl-5" variant="plain">
                  Name
                </Th>
                <Th variant="plain">Team</Th>
                <Th variant="plain">Status</Th>
                <Th variant="plain">Version</Th>
                <Th variant="plain">Last run</Th>
                <Th variant="plain">Updated</Th>
                <Th className="pr-4" variant="plain">
                  <span className="sr-only">Actions</span>
                </Th>
              </THead>
              <tbody>
                {visibleTemplates.map((t) => (
                  <TemplateRow
                    canWrite={canWrite(t.team?.id)}
                    key={t.id}
                    onArchive={setArchiveTarget}
                    onError={setRestoreError}
                    template={t}
                  />
                ))}
              </tbody>
            </Table>
          )}
        </QueryBoundary>
      </Card>

      {/* Starter gallery */}
      <details className="group rounded-xl border border-ink-500/70 bg-ink-900/30">
        <summary
          className={cn(
            'flex cursor-pointer list-none items-center gap-3 rounded-xl px-5 py-4 [&::-webkit-details-marker]:hidden',
            FOCUS_RING
          )}
        >
          <Icon
            className="text-paper-500 transition-transform group-open:rotate-90"
            name="chevronRight"
            size={16}
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-paper-100">Start from a starter</span>
            <span className="block text-[13px] text-paper-500">
              Fork a ready-made workflow and edit it as your own
            </span>
          </span>
        </summary>
        <div className="border-t border-ink-600 px-5 py-5">
          {forkError && <Alert className="mb-4">{forkError}</Alert>}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {STARTER_TEMPLATES.map((s) => {
              const isForking = forkingId === s.id;
              return (
                <Card className="flex flex-col p-5 hover:border-ink-300" key={s.id} variant="inset">
                  <div className="mb-1 text-xs font-medium text-paper-500">{s.tagline}</div>
                  <h3 className="mb-2 text-base font-semibold text-paper-100">{s.name}</h3>
                  <p className="mb-5 flex-1 text-[13px] leading-relaxed text-paper-400">
                    {s.description}
                  </p>
                  <span className="self-start" title={manageTitle}>
                    <Button
                      aria-describedby={manageTitle ? 'manage-reason' : undefined}
                      disabled={!canManage || isForking || createTemplate.isPending}
                      onClick={() => handleFork(s)}
                      size="sm"
                      variant="secondary"
                    >
                      <Icon name="copy" size={13} />
                      {isForking ? 'Forking…' : 'Fork starter'}
                    </Button>
                  </span>
                </Card>
              );
            })}
          </div>
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
