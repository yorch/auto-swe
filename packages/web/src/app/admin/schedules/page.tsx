'use client';

import type { BudgetTier, ScheduledWorkRequestSummary } from '@auto-swe/shared/types/api';
import { BUDGET_TIERS } from '@auto-swe/shared/types/workflow';
import { useId, useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { useDataTableSort } from '@/hooks/useDataTableSort';
import { useHasRole } from '@/hooks/useHasRole';
import { useRepositories } from '@/hooks/useRepositories';
import {
  useCreateSchedule,
  useDeleteSchedule,
  useFireSchedule,
  useSchedules,
  useUpdateSchedule,
} from '@/hooks/useSchedules';
import { useLedTeamIds } from '@/hooks/useTeams';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';
import { BUDGET_TIER_OPTIONS } from '@/lib/govLabels';
import { formatDate, formatRelativeTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

/** A fire time, relative ("in 3 days") with the exact time on hover; a dash when there is none. */
function When({ iso }: { iso: string | null | undefined }) {
  if (!iso) {
    return <span className="text-paper-600">—</span>;
  }
  return (
    <time className="whitespace-nowrap tabular-nums" dateTime={iso} title={formatDate(iso)}>
      {formatRelativeTime(iso)}
    </time>
  );
}

type ScheduleForm = {
  name: string;
  cronExpression: string;
  repoId: string;
  teamId: string;
  description: string;
  externalTicketPrefix: string;
  budgetTier: BudgetTier;
  templateId: string;
};

const EMPTY_FORM: ScheduleForm = {
  budgetTier: 'STANDARD',
  cronExpression: '0 3 * * 1',
  description: '',
  externalTicketPrefix: '',
  name: '',
  repoId: '',
  teamId: '',
  templateId: '',
};

function formFromSchedule(s: ScheduledWorkRequestSummary): ScheduleForm {
  return {
    budgetTier: BUDGET_TIERS.find((t) => t === s.budgetTier) ?? 'STANDARD',
    cronExpression: s.cronExpression,
    description: s.description,
    externalTicketPrefix: s.externalTicketPrefix,
    name: s.name,
    repoId: s.repository.id,
    teamId: s.team?.id ?? '',
    templateId: s.template?.id ?? '',
  };
}

/** Creates a schedule, or — given `schedule` — edits the parts of one that can change. */
function ScheduleFormModal({
  open,
  onClose,
  schedule,
}: {
  open: boolean;
  onClose: () => void;
  schedule?: ScheduledWorkRequestSummary;
}) {
  const editing = schedule !== undefined;
  // Ids are per instance: the create and edit dialogs are both on the page.
  const uid = useId();
  const [form, setForm] = useState<ScheduleForm>(() =>
    schedule ? formFromSchedule(schedule) : EMPTY_FORM
  );
  const [error, setError] = useState<string | null>(null);
  const create = useCreateSchedule();
  const update = useUpdateSchedule();
  const { data: repos } = useRepositories();
  const { data: templates } = useWorkflowTemplates();
  const isAdmin = useHasRole('ADMIN');
  const ledTeamIds = useLedTeamIds();

  // The teams that may own a schedule on the chosen repository (its owner and
  // the teams it is shared with) that the caller leads. With one, the server's
  // default is right and no picker is shown.
  const repo = (repos ?? []).find((r) => r.id === form.repoId);
  const eligibleTeams = repo
    ? [repo.team, ...(repo.shares ?? []).map((s) => s.team)].filter(
        (t) => isAdmin || ledTeamIds?.has(t.id)
      )
    : [];
  const showTeamPicker = eligibleTeams.length > 1;
  const teamId = eligibleTeams.some((t) => t.id === form.teamId)
    ? form.teamId
    : (eligibleTeams[0]?.id ?? '');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (schedule) {
        // The repository, ticket prefix and owning team are fixed at creation.
        await update.mutateAsync({
          budgetTier: form.budgetTier,
          cronExpression: form.cronExpression,
          description: form.description,
          id: schedule.id,
          name: form.name,
          templateId: form.templateId || null,
        });
        onClose();
        return;
      }
      await create.mutateAsync({
        budgetTier: form.budgetTier,
        cronExpression: form.cronExpression,
        description: form.description,
        externalTicketPrefix: form.externalTicketPrefix,
        name: form.name,
        repoId: form.repoId,
        ...(showTeamPicker ? { teamId } : {}),
        ...(form.templateId ? { templateId: form.templateId } : {}),
      });
      onClose();
      setForm(EMPTY_FORM);
    } catch (err) {
      setError(errMsg(err, editing ? 'Failed to save the schedule' : 'Failed to create schedule'));
    }
  }

  return (
    <Modal onClose={onClose} open={open} title={editing ? 'Edit schedule' : 'New schedule'}>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <Input
          id={`${uid}-name`}
          label="Name"
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="Weekly dependency update"
          required
          value={form.name}
        />
        {!editing && (
          <Combobox
            id={`${uid}-repo`}
            label="Repository"
            onChange={(v) => setForm((f) => ({ ...f, repoId: v }))}
            options={(repos ?? [])
              .filter((r) => r.isActive)
              .map((r) => ({
                label: `${r.organizationName}/${r.repoName}`,
                value: r.id,
              }))}
            placeholder="Select a repository…"
            required
            value={form.repoId}
          />
        )}
        {!editing && showTeamPicker && (
          <Combobox
            id={`${uid}-team`}
            label="Owning team"
            onChange={(v) => setForm((f) => ({ ...f, teamId: v }))}
            options={eligibleTeams.map((t) => ({ label: t.name, value: t.id }))}
            value={teamId}
          />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            hint="Minute hour day month weekday, in UTC. 0 3 * * 1 is Mondays at 03:00."
            id={`${uid}-cron`}
            label="Cron (5-field, UTC)"
            onChange={(e) => setForm((f) => ({ ...f, cronExpression: e.target.value }))}
            placeholder="0 3 * * 1"
            required
            value={form.cronExpression}
          />
          {!editing && (
            <Input
              hint="Names the ticket and branch every run of this schedule uses."
              id={`${uid}-ticket-prefix`}
              label="Ticket prefix"
              onChange={(e) => setForm((f) => ({ ...f, externalTicketPrefix: e.target.value }))}
              placeholder="DEPS"
              required
              value={form.externalTicketPrefix}
            />
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Combobox
            id={`${uid}-template`}
            label="Workflow template"
            onChange={(v) => setForm((f) => ({ ...f, templateId: v }))}
            options={[
              { label: 'Team default', value: '' },
              ...(templates ?? []).map((t) => ({ label: t.name, value: t.id })),
            ]}
            value={form.templateId}
          />
          <Select
            id={`${uid}-budget-tier`}
            label="Budget tier"
            onChange={(v) =>
              setForm((f) => ({
                ...f,
                budgetTier: v as ScheduleForm['budgetTier'],
              }))
            }
            options={BUDGET_TIER_OPTIONS}
            value={form.budgetTier}
          />
        </div>
        <Textarea
          id={`${uid}-description`}
          label="Description (what the agent should do each fire)"
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          placeholder="Update all dependencies to their latest compatible versions and fix any breakages."
          required
          rows={4}
          value={form.description}
        />
        {editing && (
          <p className="text-xs text-paper-500">
            Saving changes to what the schedule does, when it runs or how much it may spend makes it
            run as you from now on, using your saved GitHub token. The change is recorded in the
            audit log.
          </p>
        )}
        {error && <Alert variant="error">{error}</Alert>}
        <ModalFooter
          isPending={create.isPending || update.isPending}
          onCancel={onClose}
          pendingLabel={editing ? 'Saving…' : 'Creating…'}
          submitLabel={editing ? 'Save changes' : 'Create schedule'}
        />
      </form>
    </Modal>
  );
}

/**
 * What fires actually obey is the Temporal schedule; the row is only what the
 * dashboard recorded. This is the live state, and whether the two disagree.
 */
function liveState(schedule: ScheduledWorkRequestSummary) {
  const live = schedule.schedule;
  return {
    livePaused: live.exists ? live.paused : !schedule.isActive,
    mismatch: live.exists && live.paused === schedule.isActive,
  };
}

function ScheduleStatus({ schedule }: { schedule: ScheduledWorkRequestSummary }) {
  const live = schedule.schedule;
  const { livePaused, mismatch } = liveState(schedule);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge dot tone={livePaused ? 'muted' : 'success'} variant="outline">
        {livePaused ? 'Paused' : 'Active'}
      </Badge>
      {mismatch && (
        <Badge
          title={`The dashboard records this schedule as ${schedule.isActive ? 'active' : 'paused'}, but the scheduler has it ${live.paused ? 'paused' : 'running'}. An owning-team lead can pause it again to re-sync it; resuming it makes it run as you.`}
          tone="danger"
          variant="outline"
        >
          Out of sync
        </Badge>
      )}
      {schedule.schedule.unavailable && (
        <Badge
          title="The scheduler cannot be reached right now, so the live state of this schedule is unknown. The dates shown may be out of date."
          tone="muted"
          variant="outline"
        >
          Scheduler unavailable
        </Badge>
      )}
      {schedule.schedule.exists === false && (
        <Badge
          title="The scheduler has no trigger for this schedule. Edit and save it to create the trigger again."
          tone="danger"
          variant="outline"
        >
          Not running — re-save to repair
        </Badge>
      )}
    </div>
  );
}

/** A row's controls and the confirmations behind them. */
function ScheduleActions({
  schedule,
  onDelete,
  onEdit,
  onError,
}: {
  schedule: ScheduledWorkRequestSummary;
  onDelete: () => void;
  onEdit: () => void;
  /** Reports a failed action (or null on a new attempt) to the page, which shows it. */
  onError: (message: string | null) => void;
}) {
  const update = useUpdateSchedule();
  const fire = useFireSchedule();
  const [confirmFire, setConfirmFire] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const me = useAuthStore((s) => s.user);

  const { livePaused } = liveState(schedule);
  // Firing by hand as someone other than the author makes the schedule run as
  // you from then on, so it is confirmed rather than a surprise.
  const takesOver = schedule.actsAs?.id !== me?.sub;
  const actsAsName = schedule.actsAs
    ? (schedule.actsAs.name ?? schedule.actsAs.email)
    : 'the platform';
  // Resuming follows what is actually running, like the badge. It makes the
  // resumer the author, so it is confirmed like Fire when that is someone else.
  const resume = livePaused;
  const toggle = () => update.mutateAsync({ id: schedule.id, isActive: resume });

  async function run(action: () => Promise<unknown>) {
    onError(null);
    try {
      await action();
    } catch (err) {
      onError(errMsg(err, 'Action failed'));
    }
  }

  if (!schedule.canManage) {
    return <span className="text-xs text-paper-500">Team leads manage this schedule</span>;
  }

  return (
    <>
      <div className="flex items-center justify-end gap-1">
        {/* One source of truth for "is it running": the live state the badge shows. */}
        <Button
          disabled={fire.isPending || livePaused}
          onClick={() =>
            takesOver ? setConfirmFire(true) : run(() => fire.mutateAsync(schedule.id))
          }
          size="sm"
          title={livePaused ? 'Paused: resume the schedule before firing it' : undefined}
        >
          {fire.isPending ? 'Firing…' : 'Fire now'}
        </Button>
        <ActionMenu
          items={[
            { icon: 'edit', id: 'edit', label: 'Edit', onAction: onEdit },
            {
              disabled: update.isPending,
              icon: resume ? 'refresh' : 'clock',
              id: 'toggle',
              label: resume ? 'Resume' : 'Pause',
              onAction: () =>
                resume && takesOver && !schedule.isActive
                  ? setConfirmResume(true)
                  : void run(toggle),
            },
            {
              icon: 'trash',
              id: 'delete',
              label: 'Delete',
              onAction: onDelete,
              tone: 'danger',
            },
          ]}
          label={`Actions for ${schedule.name}`}
        />
      </div>
      <ConfirmModal
        confirmLabel="Resume and take over"
        message={`This schedule currently runs as ${actsAsName}. Resuming it makes it run as you for every future fire, using your saved GitHub token, until someone else takes it over. The change is recorded in the audit log.`}
        onClose={() => setConfirmResume(false)}
        onConfirm={() => run(toggle)}
        open={confirmResume}
        pendingLabel="Resuming…"
        title={`Resume "${schedule.name}" as yourself?`}
      />
      <ConfirmModal
        confirmLabel="Fire and take over"
        message={`This schedule currently runs as ${actsAsName}. Firing it now makes it run as you for every future fire, using your saved GitHub token, until someone else takes it over. The change is recorded in the audit log.`}
        onClose={() => setConfirmFire(false)}
        onConfirm={() => run(() => fire.mutateAsync(schedule.id))}
        open={confirmFire}
        pendingLabel="Firing…"
        title={`Fire "${schedule.name}" as yourself?`}
      />
    </>
  );
}

const lastFire = (s: ScheduledWorkRequestSummary) => s.schedule.lastRunAt ?? s.lastFiredAt;
const time = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : null);

const SCHEDULE_SORT_KEYS = {
  lastFire: (s: ScheduledWorkRequestSummary) => time(lastFire(s)),
  name: (s: ScheduledWorkRequestSummary) => s.name.toLowerCase(),
  nextFire: (s: ScheduledWorkRequestSummary) => time(s.schedule.nextRunAt),
};

export default function GovernSchedulesPage() {
  const [newOpen, setNewOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ScheduledWorkRequestSummary | null>(null);
  const isAdmin = useHasRole('ADMIN');
  const ledTeamIds = useLedTeamIds();
  // Mirrors the gateway: an ADMIN, or a lead of the owning or a shared team.
  const canCreate = isAdmin || (ledTeamIds?.size ?? 0) > 0;
  const [deleteTarget, setDeleteTarget] = useState<ScheduledWorkRequestSummary | null>(null);
  const [query, setQuery] = useState('');
  const { onSortChange, sort, sortRows } =
    useDataTableSort<ScheduledWorkRequestSummary>(SCHEDULE_SORT_KEYS);
  const [actionError, setActionError] = useState<string | null>(null);
  const deleteSchedule = useDeleteSchedule();
  const {
    data: schedules,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useSchedules();

  const needle = query.trim().toLowerCase();
  const shown = (schedules ?? []).filter(
    (s) =>
      !needle ||
      [
        s.name,
        s.externalTicketId,
        `${s.repository.organizationName}/${s.repository.repoName}`,
        s.team?.name ?? '',
      ].some((text) => text.toLowerCase().includes(needle))
  );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <div className="flex flex-col items-end gap-1">
            <Button disabled={!canCreate} onClick={() => setNewOpen(true)} variant="primary">
              <Icon name="plus" size={14} />
              Create schedule
            </Button>
            {!canCreate && ledTeamIds && (
              <span className="text-xs text-paper-500">Only team leads can create schedules</span>
            )}
          </div>
        }
        help={
          <p>
            Every run reuses the same ticket and branch, so an open pull request is updated instead
            of duplicated. Runs appear in your run history. The workflow template is fixed when you
            save the schedule.
          </p>
        }
        subtitle="Recurring work: each schedule starts a workflow on a repeating timetable against one repository, such as a weekly dependency update."
        title="Scheduled work requests"
      />

      <Card>
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="schedules"
          onRetry={() => void refetch()}
        >
          {!schedules?.length ? (
            <EmptyState
              action={
                canCreate ? (
                  <Button onClick={() => setNewOpen(true)} size="sm">
                    Create schedule
                  </Button>
                ) : undefined
              }
              hint="A schedule starts the same workflow on a timetable — a weekly dependency update, a nightly lint fix. Runs appear in your run history."
              icon="clock"
              title="No schedules yet"
            />
          ) : (
            <>
              <Toolbar
                end={
                  <span className="text-xs text-paper-500 tabular-nums">
                    {needle ? `${shown.length} of ${schedules.length}` : schedules.length} schedule
                    {schedules.length === 1 ? '' : 's'} · times in your time zone, cron in UTC
                  </span>
                }
              >
                <SearchInput
                  label="Search schedules"
                  onChange={setQuery}
                  placeholder="Search schedules…"
                  value={query}
                />
              </Toolbar>
              {actionError && <Alert className="mb-3">{actionError}</Alert>}
              {shown.length === 0 ? (
                <EmptyState
                  action={
                    <Button onClick={() => setQuery('')} size="sm">
                      Clear search
                    </Button>
                  }
                  icon="search"
                  title="No schedules match your search"
                />
              ) : (
                <div className="-mx-4">
                  <DataTable
                    actions={(s) => (
                      <ScheduleActions
                        onDelete={() => setDeleteTarget(s)}
                        onEdit={() => setEditTarget(s)}
                        onError={setActionError}
                        schedule={s}
                      />
                    )}
                    className="max-sm:px-4"
                    columns={[
                      {
                        cell: (s) => s.name,
                        header: 'Name',
                        id: 'name',
                        primary: true,
                        secondary: (s) => (
                          <div className="flex flex-wrap items-center gap-x-2">
                            <span className="font-mono">{s.externalTicketId}</span>
                            {/* Whose GitHub identity fires act as; editing it or firing it by hand makes it yours. */}
                            <span>
                              Runs as{' '}
                              {s.actsAs ? (s.actsAs.name ?? s.actsAs.email) : 'the platform'}
                            </span>
                          </div>
                        ),
                        sortable: true,
                      },
                      {
                        cell: (s) => (
                          <>
                            <div className="whitespace-nowrap font-mono text-sm text-paper-200">
                              {s.repository.organizationName}/{s.repository.repoName}
                            </div>
                            <div className="mt-0.5 text-xs text-paper-500">
                              {s.team ? `Team ${s.team.name}` : 'No team (team deleted)'}
                            </div>
                          </>
                        ),
                        header: 'Repository',
                        id: 'repository',
                      },
                      {
                        cell: (s) => (
                          <>
                            <code className="whitespace-nowrap font-mono text-sm text-paper-200">
                              {s.cronExpression}
                            </code>
                            <div className="mt-0.5 text-xs text-paper-500">
                              {s.template
                                ? `${s.template.name} v${s.templateVersion ?? '?'}`
                                : 'Team default template'}
                            </div>
                          </>
                        ),
                        header: 'Schedule',
                        id: 'schedule',
                      },
                      {
                        cell: (s) => <ScheduleStatus schedule={s} />,
                        header: 'Status',
                        id: 'status',
                      },
                      {
                        cell: (s) => (
                          <span className="text-paper-300">
                            <When iso={s.schedule.nextRunAt} />
                          </span>
                        ),
                        header: 'Next fire',
                        id: 'nextFire',
                        sortable: true,
                      },
                      {
                        cell: (s) => (
                          <span className="text-paper-400">
                            <When iso={lastFire(s)} />
                          </span>
                        ),
                        header: 'Last fire',
                        id: 'lastFire',
                        sortable: true,
                      },
                    ]}
                    getRowId={(s) => s.id}
                    onSortChange={onSortChange}
                    revealActions={false}
                    rows={sortRows(shown)}
                    sort={sort}
                  />
                </div>
              )}
            </>
          )}
        </QueryBoundary>
      </Card>

      <ScheduleFormModal onClose={() => setNewOpen(false)} open={newOpen} />
      {/* Keyed by schedule so each edit starts from that schedule's current values. */}
      {editTarget && (
        <ScheduleFormModal
          key={editTarget.id}
          onClose={() => setEditTarget(null)}
          open
          schedule={editTarget}
        />
      )}
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message="This removes the schedule and stops its future runs. Past runs and their history are kept."
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await deleteSchedule.mutateAsync(deleteTarget.id);
          }
        }}
        open={deleteTarget !== null}
        pendingLabel="Deleting…"
        title={`Delete "${deleteTarget?.name ?? ''}"?`}
      />
    </div>
  );
}
