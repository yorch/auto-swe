'use client';

import { handLaunchBlock, isSystemManagedTemplate } from '@auto-swe/shared/lib/channelTask';
import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { TeamChip } from '@/components/teams/TeamChip';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SparkleIcon } from '@/components/ui/icons';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { NODE_TYPE_LABEL } from '@/components/workflow/nodeTypeTone';
import { STARTER_TEMPLATES, type StarterTemplate } from '@/components/workflow/starterTemplates';
import { VersionTags } from '@/components/workflow/VersionTags';
import { useDebouncedUrlSearch } from '@/hooks/useDebouncedUrlSearch';
import { useHasRole } from '@/hooks/useHasRole';
import { useTeamParam } from '@/hooks/useTeamParam';
import { useAuthoringTeams, useLedTeamIds } from '@/hooks/useTeams';
import {
  useCreateWorkflowTemplate,
  useStartWorkflowGenerationJob,
  useUpdateWorkflowTemplate,
  useWorkflowGenerationJob,
  useWorkflowTemplates,
} from '@/hooks/useTemplates';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { runHref, templateHref } from '@/lib/entityLinks';
import { errMsg } from '@/lib/errors';
import { HELP_LINKS } from '@/lib/helpLinks';
import { requestHref } from '@/lib/requestDisplay';
import { requiresRoleTitle } from '@/lib/roles';
import { teamGatedBoundary } from '@/lib/teamGate';
import { canWriteTeamResource } from '@/lib/teamPermissions';
import { cn, FOCUS_RING, formatDate, formatRelativeTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
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

const JOB_PHASE_LABEL: Record<string, string> = {
  done: 'Finishing…',
  generating: 'Designing the workflow…',
  persisting: 'Saving the draft…',
};

/** Where a new workflow is created: the teams the caller may author for. */
interface CreateTarget {
  /** A platform ADMIN may also create a workflow that belongs to no team. */
  global: boolean;
  teams: { id: string; name: string }[];
  /** '' is no team (global); only meaningful when `global`. */
  teamId: string;
  onChange: (teamId: string) => void;
}

/** The team a new workflow is created for; the caller picks it, there is no ambient team. */
function CreateTeamSelect({ target, disabled }: { target: CreateTarget; disabled?: boolean }) {
  return (
    <Select
      disabled={disabled}
      hint={
        target.global || target.teams.length > 0
          ? 'The team owns the workflow; its leads can edit it.'
          : 'You need to lead a team to create a workflow.'
      }
      label="Team"
      onChange={target.onChange}
      options={[
        ...(target.global ? [{ label: 'No team (platform-wide)', value: '' }] : []),
        ...(!target.global && !target.teamId ? [{ label: 'Choose a team…', value: '' }] : []),
        ...target.teams.map((t) => ({ label: t.name, value: t.id })),
      ]}
      value={target.teamId}
    />
  );
}

function NewTemplateModal({
  open,
  onClose,
  target,
}: {
  open: boolean;
  onClose: () => void;
  target: CreateTarget;
}) {
  const router = useRouter();
  const selectedTeamId = target.teamId;
  const needsTeam = !target.global && !selectedTeamId;
  const startJob = useStartWorkflowGenerationJob();
  const createTemplate = useCreateWorkflowTemplate();
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [mode, setMode] = useState<'describe' | 'wizard' | 'blank'>('describe');
  const [blankDescription, setBlankDescription] = useState('');

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
    setBlankDescription('');
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
      router.push(`/library/${id}`);
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

  const handleCreateBlank = async () => {
    const trimmed = name.trim();
    if (needsTeam) {
      setError('Choose the team that will own the workflow');
      return;
    }
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    setError(null);
    try {
      const spec: WorkflowSpec = { ...BLANK_SPEC, name: trimmed };
      const result = await createTemplate.mutateAsync({
        description: blankDescription.trim() || undefined,
        name: trimmed,
        spec,
        teamId: selectedTeamId || undefined,
      });
      const data = (result as { data: { id: string } }).data;
      onClose();
      reset();
      router.push(`/library/${data.id}`);
    } catch (err) {
      setError(errMsg(err, 'create failed'));
    }
  };

  const handleGenerate = async (forcedPrompt?: string) => {
    const effectivePrompt = (
      forcedPrompt ?? (mode === 'wizard' ? buildWizardPrompt() : prompt)
    ).trim();
    if (needsTeam) {
      setError('Choose the team that will own the workflow');
      return;
    }
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
        teamId: selectedTeamId || undefined,
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
  const generating =
    startJob.isPending || (jobId !== null && job?.status !== 'done' && job?.status !== 'failed');
  const busy = generating || createTemplate.isPending;
  const phaseLabel =
    job?.status === 'running' ? (JOB_PHASE_LABEL[job.phase ?? 'generating'] ?? 'Working…') : null;

  return (
    <Modal
      // A generation job is billed and keeps running; closing now would hide its result.
      dismissible={!busy}
      onClose={() => {
        onClose();
        setError(null);
      }}
      open={open}
      title="New workflow"
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <SegmentedControl
          ariaLabel="How to create the workflow"
          onChange={(next) => {
            setMode(next);
            setError(null);
          }}
          options={[
            { label: 'Describe', value: 'describe' },
            { label: 'Answer questions', value: 'wizard' },
            { label: 'Blank', value: 'blank' },
          ]}
          value={mode}
        />
        {mode === 'blank' && (
          <p className="text-sm leading-relaxed text-paper-400">
            Start from an empty canvas with one placeholder step. Nothing is generated.
          </p>
        )}
        {mode === 'describe' ? (
          <p className="text-sm leading-relaxed text-paper-400">
            Describe what you want the workflow to do in plain language. An AI agent assembles a
            workflow from your available steps, agents, and connections, and saves it as a{' '}
            <span className="font-medium text-paper-300">draft</span> for you to review and edit on
            the canvas before activating.
          </p>
        ) : mode === 'wizard' ? (
          <p className="text-sm leading-relaxed text-paper-400">
            Answer a few questions and the AI will assemble a draft workflow from your answers. You
            can refine it on the canvas before activating.
          </p>
        ) : null}
        {mode === 'blank' ? (
          <Textarea
            hint="Optional"
            label="Description"
            onChange={(e) => setBlankDescription(e.target.value)}
            placeholder="What does this workflow do?"
            rows={3}
            value={blankDescription}
          />
        ) : mode === 'describe' ? (
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
        <CreateTeamSelect disabled={busy} target={target} />
        <Input
          disabled={busy}
          hint={mode === 'blank' ? undefined : 'Optional — defaults to a name the AI picks'}
          label="Name"
          onChange={(e) => setName(e.target.value)}
          placeholder="my-workflow"
          required={mode === 'blank'}
          value={name}
        />
        <ModalFooter
          isPending={busy}
          onCancel={() => {
            // Typed text is kept, so reopening does not lose a long prompt.
            onClose();
            setError(null);
          }}
          onSubmit={() => (mode === 'blank' ? handleCreateBlank() : handleGenerate())}
          pendingLabel={mode === 'blank' ? 'Creating…' : 'Generating…'}
          submitLabel={mode === 'blank' ? 'Create blank workflow' : 'Generate draft'}
        >
          {phaseLabel && (
            <span aria-live="polite" className="text-xs text-paper-400">
              {phaseLabel}
            </span>
          )}
          {generating && !phaseLabel && (
            <span aria-live="polite" className="text-xs text-paper-400">
              Generation takes a moment. Keep this open; the draft opens when it is ready.
            </span>
          )}
        </ModalFooter>
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
 * a compact label explaining its launch path.
 */
function RunAction({ template }: { template: WorkflowTemplateSummary }) {
  if (template.status === 'ARCHIVED') {
    return (
      <Badge
        className="inline-flex min-h-8 items-center px-2.5"
        title="Restore this archived workflow before running it"
        tone="neutral"
      >
        Archived
      </Badge>
    );
  }
  const block = handLaunchBlock(template);
  if (block) {
    return (
      <Badge
        className="inline-flex min-h-8 items-center px-2.5"
        title={block.reason}
        tone="neutral"
      >
        {template.kind === 'review' ? 'Review only' : 'Automatic'}
        <span className="sr-only">: {block.reason}</span>
      </Badge>
    );
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
    <Badge className="inline-flex min-h-8 items-center px-2.5" title={reason} tone="neutral">
      Not ready<span className="sr-only">: {reason}</span>
    </Badge>
  );
}

function TemplateActions({
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
  const href = templateHref(t.id);
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
    <>
      <RunAction template={t} />
      <ActionMenu items={menuItems} label={`More actions for ${t.name}`} />
    </>
  );
}

const templateColumns: DataTableColumn<WorkflowTemplateSummary>[] = [
  {
    cell: (t) => t.name,
    header: 'Name',
    id: 'name',
    primary: true,
    secondary: (t) => (
      <>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <VersionTags isDefault={t.isDefault} />
          {isSystemManagedTemplate(t) && (
            <Badge title="Started by the platform; it cannot be run by hand" tone="neutral">
              Used by channel assistants
            </Badge>
          )}
          {t.webhookConfigured && (
            <Badge title="A webhook URL can start this workflow" tone="accent2" variant="outline">
              Webhook
            </Badge>
          )}
        </div>
        {t.description && (
          <p
            className="mt-0.5 line-clamp-1 max-w-xl text-sm font-normal text-paper-400 max-sm:line-clamp-2"
            title={t.description}
          >
            {t.description}
          </p>
        )}
      </>
    ),
  },
  {
    cell: (t) => (
      <span className="whitespace-nowrap text-sm text-paper-300">
        {t.team?.name ?? <span className="text-paper-500">Platform-wide</span>}
      </span>
    ),
    header: 'Team',
    id: 'team',
  },
  { cell: (t) => <StatusBadge status={t.status} />, header: 'Status', id: 'status' },
  {
    cell: (t) =>
      t.activeVersion !== null ? (
        <span className="text-sm text-paper-300 tabular-nums">v{t.activeVersion}</span>
      ) : (
        <span className="text-paper-500">—</span>
      ),
    header: 'Version',
    id: 'version',
  },
  {
    cell: (t) =>
      t.lastRun ? (
        <Link
          className={cn('inline-flex items-center gap-2 rounded-sm', FOCUS_RING)}
          href={
            t.lastRun.workRequestId ? requestHref(t.lastRun.workRequestId) : runHref(t.lastRun.id)
          }
          title={formatDate(t.lastRun.startedAt)}
        >
          <StatusBadge status={t.lastRun.status} />
          <span className="text-xs text-paper-500 tabular-nums">
            {formatRelativeTime(t.lastRun.startedAt)}
          </span>
        </Link>
      ) : (
        <span className="text-sm text-paper-500">Never</span>
      ),
    header: 'Last run',
    id: 'lastRun',
  },
  {
    cell: (t) => <RelativeTime className="text-sm text-paper-500" value={t.updatedAt} />,
    header: 'Updated',
    id: 'updated',
  },
];

const STATUS_FILTERS = ['current', 'active', 'draft', 'archived'] as const;

function parseStatusFilter(raw: string | null): StatusFilter {
  return STATUS_FILTERS.find((f) => f === raw) ?? 'current';
}

export default function TemplatesPage() {
  return (
    <Suspense>
      <TemplatesPageContent />
    </Suspense>
  );
}

function TemplatesPageContent() {
  const router = useRouter();
  const { params, update } = useUrlFilters();
  const teamFilter = useTeamParam();
  const authoring = useAuthoringTeams();
  const [pickedTeamId, setPickedTeamId] = useState<string | null>(null);
  // The team a new workflow is created for: the caller's pick, else the `?team=` team when they
  // may author for it, else their only team, else (platform ADMIN) none.
  const defaultCreateTeamId =
    authoring.teams.find((t) => t.id === teamFilter.teamId)?.id ??
    (!authoring.global && authoring.teams.length === 1 ? authoring.teams[0]?.id : undefined) ??
    '';
  const createTarget: CreateTarget = {
    global: authoring.global,
    onChange: setPickedTeamId,
    teamId: pickedTeamId ?? defaultCreateTeamId,
    teams: authoring.teams,
  };
  const {
    data: templates,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useWorkflowTemplates(teamFilter.teamId, { enabled: !teamFilter.blocked });
  const createTemplate = useCreateWorkflowTemplate();
  // Creating, forking and archiving templates are LEAD routes on the gateway,
  // and on top of the platform role the gateway requires LEAD membership on the
  // owning team (templateWriteFilter); a GLOBAL template is ADMIN-only. A new
  // template is created for a team the caller picks, from the teams they lead
  // (a platform ADMIN may pick any team, or none).
  const platformRole = useAuthStore((s) => s.user?.role);
  const isLead = useHasRole('LEAD');
  const ledTeamIds = useLedTeamIds();
  const canWrite = (teamId: string | null | undefined) =>
    canWriteTeamResource(platformRole, teamId, ledTeamIds);
  const canManage = authoring.global || authoring.teams.length > 0;
  const manageTitle = canManage
    ? undefined
    : isLead
      ? 'Lead a team to author workflows for it'
      : requiresRoleTitle('LEAD');
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<{ id: string; name: string } | null>(null);
  // Status and search live in the address bar, so a filtered list survives a reload and can be shared.
  const statusFilter = parseStatusFilter(params.get('status'));
  const setStatusFilter = (next: StatusFilter) =>
    update({ status: next === 'current' ? null : next });
  const [search, setSearch] = useDebouncedUrlSearch(params.get('q') ?? '', (value) =>
    update({ q: value || null })
  );
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const all = templates ?? [];
  const searched = all.filter((t) => matchesSearch(t, search));
  const visibleTemplates = searched.filter((t) => matchesStatusFilter(t, statusFilter));
  const searching = search.trim() !== '';
  // Counts follow the search, so a badge never promises more rows than the list shows.
  const statusCount = (f: StatusFilter) => searched.filter((t) => matchesStatusFilter(t, f)).length;

  const handleFork = async (starter: StarterTemplate) => {
    setForkingId(starter.id);
    setForkError(null);
    if (!createTarget.global && !createTarget.teamId) {
      setForkError('Choose the team that will own the workflow, under “Start from a starter”.');
      setForkingId(null);
      return;
    }
    try {
      const suffix = Math.random().toString(36).slice(2, 6);
      const name = `${starter.spec.name}-${suffix}`;
      const spec: WorkflowSpec = { ...starter.spec, name };
      const result = await createTemplate.mutateAsync({
        description: starter.spec.description,
        name,
        spec,
        teamId: createTarget.teamId || undefined,
      });
      const data = (result as { data: { id: string } }).data;
      router.push(`/library/${data.id}`);
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
      <NewTemplateModal
        onClose={() => setGenerateOpen(false)}
        open={generateOpen}
        target={createTarget}
      />

      <ArchiveConfirmModal onClose={() => setArchiveTarget(null)} target={archiveTarget} />

      <PageHeader
        actions={newWorkflowButton}
        help={
          <p>
            A workflow template <HelpTip term="workflowTemplate" /> is reusable: pick one, run it
            with your inputs, and follow the request.
          </p>
        }
        learnMore={{ ...HELP_LINKS.conceptsWorkflows, label: 'About workflows' }}
        subtitle={
          <>
            Your reusable workflow templates.
            {manageTitle && (
              <span className="mt-1 block text-xs text-paper-500" id="manage-reason">
                {manageTitle}.
              </span>
            )}
          </>
        }
        title="Workflow library"
      />

      <TeamChip onRemove={teamFilter.clear} team={teamFilter.team} />

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
            options={STATUS_FILTERS.map((f) => ({
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
        <p className="border-b border-ink-600 px-4 py-2 text-xs text-paper-500 sm:px-5">
          Active templates can be launched once a version is promoted. Drafts are still being edited
          and cannot be launched until someone activates them. Archived templates are hidden from
          the default list and cannot be launched.
        </p>
        <QueryBoundary
          {...teamGatedBoundary(teamFilter, {
            error: loadError,
            isError,
            isFetching,
            isLoading,
            refetch,
          })}
          label="workflows"
          loading={<SkeletonRows className="px-5 py-4" label="workflows" rows={8} />}
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
            <DataTable
              actions={(t) => (
                <TemplateActions
                  canWrite={canWrite(t.team?.id)}
                  onArchive={setArchiveTarget}
                  onError={setRestoreError}
                  template={t}
                />
              )}
              columns={templateColumns}
              getRowId={(t) => t.id}
              revealActions={false}
              rowHref={(t) => templateHref(t.id)}
              rows={visibleTemplates}
            />
          )}
        </QueryBoundary>
      </Card>

      {/* Starter gallery */}
      <details
        className="group rounded-xl border border-ink-500/70 bg-ink-900/30"
        open={templates !== undefined && all.length === 0 ? true : undefined}
      >
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
            <span className="block text-sm text-paper-500">
              Fork a ready-made workflow and edit it as your own
            </span>
          </span>
        </summary>
        <div className="border-t border-ink-600 px-5 py-5">
          {forkError && <Alert className="mb-4">{forkError}</Alert>}
          {canManage && (
            <div className="mb-4 max-w-xs">
              <CreateTeamSelect target={createTarget} />
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {STARTER_TEMPLATES.map((s) => {
              const isForking = forkingId === s.id;
              return (
                <Card className="flex flex-col p-5 hover:border-ink-300" key={s.id} variant="inset">
                  <div className="mb-1 text-xs font-medium text-paper-500">{s.tagline}</div>
                  <h3 className="mb-2 text-base font-semibold text-paper-100">{s.name}</h3>
                  <p className="mb-3 flex-1 text-sm leading-relaxed text-paper-400">
                    {s.description}
                  </p>
                  <p className="mb-5 text-xs text-paper-500">
                    Teaches: {s.teaches.map((t) => NODE_TYPE_LABEL[t]).join(', ')}
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
