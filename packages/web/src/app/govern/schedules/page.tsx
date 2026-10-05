'use client';

import type { ScheduledWorkRequestSummary } from '@auto-swe/shared/types/api';
import { useId, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { Textarea } from '@/components/ui/Textarea';
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
import { formatDate } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

function fmtTime(iso: string | null | undefined): string {
  return iso ? formatDate(iso) : '—';
}

type ScheduleForm = {
  name: string;
  cronExpression: string;
  repoId: string;
  teamId: string;
  description: string;
  externalTicketPrefix: string;
  budgetTier: 'STANDARD' | 'LARGE' | 'EPIC';
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

const BUDGET_TIER_OPTIONS = [
  { label: 'Standard', value: 'STANDARD' },
  { label: 'Large', value: 'LARGE' },
  { label: 'Epic', value: 'EPIC' },
];

function formFromSchedule(s: ScheduledWorkRequestSummary): ScheduleForm {
  return {
    budgetTier:
      (['STANDARD', 'LARGE', 'EPIC'] as const).find((t) => t === s.budgetTier) ?? 'STANDARD',
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
        <div className="grid grid-cols-2 gap-4">
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
        <div className="grid grid-cols-2 gap-4">
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

function ScheduleRow({
  schedule,
  onDelete,
  onEdit,
}: {
  schedule: ScheduledWorkRequestSummary;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const update = useUpdateSchedule();
  const fire = useFireSchedule();
  const [error, setError] = useState<string | null>(null);
  const [confirmFire, setConfirmFire] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const me = useAuthStore((s) => s.user);

  // What fires actually obey is the Temporal schedule; the row is only what the
  // dashboard recorded. Show the live state and flag the two disagreeing.
  const live = schedule.schedule;
  const livePaused = live.exists ? live.paused : !schedule.isActive;
  const mismatch = live.exists && live.paused === schedule.isActive;
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
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errMsg(err, 'Action failed'));
    }
  }

  return (
    <>
      <TRow>
        <Td className="py-2 pr-4">
          <div className="font-medium text-paper-100">{schedule.name}</div>
          <div className="font-mono text-[10px] text-paper-500">{schedule.externalTicketId}</div>
          {/* Whose GitHub identity fires act as; editing it or firing it by hand makes it yours. */}
          <div className="text-[11px] text-paper-500">Runs as: {actsAsName}</div>
        </Td>
        <Td className="py-2 pr-4 text-paper-400">
          {schedule.repository.organizationName}/{schedule.repository.repoName}
          <div className="text-[11px] text-paper-500">
            Team: {schedule.team?.name ?? 'none (team deleted)'}
          </div>
        </Td>
        <Td className="py-2 pr-4 font-mono text-xs text-paper-300">{schedule.cronExpression}</Td>
        <Td className="py-2 pr-4 text-paper-400">
          {schedule.template
            ? `${schedule.template.name} v${schedule.templateVersion ?? '?'}`
            : 'team default'}
        </Td>
        <Td className="py-2 pr-4">
          <Badge tone={livePaused ? 'muted' : 'ember'} uppercase variant="text">
            {livePaused ? 'paused' : 'active'}
          </Badge>
          {mismatch && (
            <Badge
              className="ml-2"
              title={`The dashboard records this schedule as ${schedule.isActive ? 'active' : 'paused'}, but the scheduler has it ${live.paused ? 'paused' : 'running'}. An owning-team lead can pause it again to re-sync it; resuming it makes it run as you.`}
              tone="brick"
              uppercase
              variant="text"
            >
              out of sync
            </Badge>
          )}
          {!schedule.schedule.exists && (
            <Badge
              className="ml-2"
              title="The scheduler has no trigger for this schedule. Edit and save it to create the trigger again."
              tone="brick"
              uppercase
              variant="text"
            >
              Not running — re-save to repair
            </Badge>
          )}
        </Td>
        <Td className="py-2 pr-4 text-xs text-paper-400">{fmtTime(schedule.schedule.nextRunAt)}</Td>
        <Td className="py-2 pr-4 text-xs text-paper-400">
          {fmtTime(schedule.schedule.lastRunAt ?? schedule.lastFiredAt)}
        </Td>
        <Td className="py-2 text-right">
          {schedule.canManage ? (
            <div className="flex justify-end gap-1">
              {/* One source of truth for "is it running": the live state the badge shows. */}
              <Button
                disabled={fire.isPending || livePaused}
                onClick={() =>
                  takesOver ? setConfirmFire(true) : run(() => fire.mutateAsync(schedule.id))
                }
                size="sm"
                title={livePaused ? 'Paused: resume the schedule before firing it' : undefined}
                variant="ghost"
              >
                {fire.isPending ? 'Firing…' : 'Fire now'}
              </Button>
              <Button onClick={onEdit} size="sm" variant="ghost">
                Edit
              </Button>
              <Button
                disabled={update.isPending}
                onClick={() =>
                  resume && takesOver && !schedule.isActive ? setConfirmResume(true) : run(toggle)
                }
                size="sm"
                variant="ghost"
              >
                {resume ? 'Resume' : 'Pause'}
              </Button>
              <Button onClick={onDelete} size="sm" variant="danger">
                Delete
              </Button>
            </div>
          ) : (
            <span className="text-[11px] text-paper-500">Team leads manage this schedule</span>
          )}
        </Td>
      </TRow>
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
      {error && (
        <TableStatusRow colSpan={8}>
          <Alert>{error}</Alert>
        </TableStatusRow>
      )}
    </>
  );
}

export default function GovernSchedulesPage() {
  const [newOpen, setNewOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ScheduledWorkRequestSummary | null>(null);
  const isAdmin = useHasRole('ADMIN');
  const ledTeamIds = useLedTeamIds();
  // Mirrors the gateway: an ADMIN, or a lead of the owning or a shared team.
  const canCreate = isAdmin || (ledTeamIds?.size ?? 0) > 0;
  const [deleteTarget, setDeleteTarget] = useState<ScheduledWorkRequestSummary | null>(null);
  const deleteSchedule = useDeleteSchedule();
  const {
    data: schedules,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useSchedules();

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <div className="flex flex-col items-end gap-1">
            <Button disabled={!canCreate} onClick={() => setNewOpen(true)} variant="primary">
              Create schedule
            </Button>
            {!canCreate && ledTeamIds && (
              <span className="text-[11px] text-paper-500">
                Only team leads can create schedules
              </span>
            )}
          </div>
        }
        chapter="§ Govern"
        subtitle="Recurring work: each schedule starts a workflow on a repeating timetable against one repository, such as a weekly dependency update. Every run reuses the same ticket and branch, so an open pull request is updated instead of duplicated. Runs appear in your run history. The workflow template is fixed when you save the schedule."
        title="Scheduled work requests"
      />

      <Card>
        <CardHeader>
          <CardTitle>All schedules</CardTitle>
        </CardHeader>
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="schedules"
          onRetry={() => void refetch()}
        >
          {!schedules?.length ? (
            <EmptyState title="No schedules yet. Create one with the button above." />
          ) : (
            <Table>
              <THead>
                <Th variant="compact">Name</Th>
                <Th variant="compact">Repository</Th>
                <Th variant="compact">Cron</Th>
                <Th variant="compact">Workflow template</Th>
                <Th variant="compact">Status</Th>
                <Th variant="compact">Next fire</Th>
                <Th variant="compact">Last fire</Th>
                <Th variant="compact" />
              </THead>
              <tbody>
                {schedules.map((s) => (
                  <ScheduleRow
                    key={s.id}
                    onDelete={() => setDeleteTarget(s)}
                    onEdit={() => setEditTarget(s)}
                    schedule={s}
                  />
                ))}
              </tbody>
            </Table>
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
