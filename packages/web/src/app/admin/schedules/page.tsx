'use client';

import type { ScheduledWorkRequestSummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useRepositories } from '@/hooks/useRepositories';
import {
  useCreateSchedule,
  useDeleteSchedule,
  useFireSchedule,
  useSchedules,
  useUpdateSchedule,
} from '@/hooks/useSchedules';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';

function fmtTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

type ScheduleForm = {
  name: string;
  cronExpression: string;
  repoId: string;
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
  templateId: '',
};

function ScheduleFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState<ScheduleForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateSchedule();
  const { data: repos } = useRepositories();
  const { data: templates } = useWorkflowTemplates();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({
        budgetTier: form.budgetTier,
        cronExpression: form.cronExpression,
        description: form.description,
        externalTicketPrefix: form.externalTicketPrefix,
        name: form.name,
        repoId: form.repoId,
        ...(form.templateId ? { templateId: form.templateId } : {}),
      });
      onClose();
      setForm(EMPTY_FORM);
    } catch (err) {
      setError(errMsg(err, 'Failed to create schedule'));
    }
  }

  return (
    <Modal eyebrow="Admin / Schedules" onClose={onClose} open={open} title="New Schedule">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <FieldWrapper label="Name">
          <Input
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Weekly dependency update"
            required
            value={form.name}
          />
        </FieldWrapper>
        <FieldWrapper label="Repository">
          <Select
            onChange={(e) => setForm((f) => ({ ...f, repoId: e.target.value }))}
            required
            value={form.repoId}
          >
            <option disabled value="">
              Select a repository…
            </option>
            {(repos ?? [])
              .filter((r) => r.isActive)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.organizationName}/{r.repoName}
                </option>
              ))}
          </Select>
        </FieldWrapper>
        <div className="grid grid-cols-2 gap-4">
          <FieldWrapper label="Cron (5-field, UTC)">
            <Input
              onChange={(e) => setForm((f) => ({ ...f, cronExpression: e.target.value }))}
              placeholder="0 3 * * 1"
              required
              value={form.cronExpression}
            />
          </FieldWrapper>
          <FieldWrapper label="Ticket Prefix">
            <Input
              onChange={(e) => setForm((f) => ({ ...f, externalTicketPrefix: e.target.value }))}
              placeholder="DEPS"
              required
              value={form.externalTicketPrefix}
            />
          </FieldWrapper>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FieldWrapper label="Template (blank → team default)">
            <Select
              onChange={(e) => setForm((f) => ({ ...f, templateId: e.target.value }))}
              value={form.templateId}
            >
              <option value="">Team default (resolved on save)</option>
              {(templates ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FieldWrapper>
          <FieldWrapper label="Budget Tier">
            <Select
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  budgetTier: e.target.value as ScheduleForm['budgetTier'],
                }))
              }
              value={form.budgetTier}
            >
              <option value="STANDARD">STANDARD</option>
              <option value="LARGE">LARGE</option>
              <option value="EPIC">EPIC</option>
            </Select>
          </FieldWrapper>
        </div>
        <FieldWrapper label="Description (what the agent should do each fire)">
          <Textarea
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Update all dependencies to their latest compatible versions and fix any breakages."
            required
            rows={4}
            value={form.description}
          />
        </FieldWrapper>
        {error && <Alert variant="error">{error}</Alert>}
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={create.isPending} type="submit" variant="primary">
            {create.isPending ? 'Creating…' : 'Create Schedule'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteConfirmModal({
  schedule,
  onClose,
}: {
  schedule: ScheduledWorkRequestSummary | null;
  onClose: () => void;
}) {
  const deleteSchedule = useDeleteSchedule();
  const [error, setError] = useState<string | null>(null);

  if (!schedule) {
    return null;
  }

  async function handleDelete() {
    if (!schedule) {
      return;
    }
    setError(null);
    try {
      await deleteSchedule.mutateAsync(schedule.id);
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Failed to delete schedule'));
    }
  }

  return (
    <Modal onClose={onClose} open={!!schedule} title={`Delete "${schedule.name}"?`}>
      <div className="space-y-4">
        <p className="text-sm text-paper-400">
          This removes the schedule and its Temporal Schedule. Past runs and their history are kept.
        </p>
        {error && <Alert variant="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={deleteSchedule.isPending} onClick={handleDelete} variant="danger">
            {deleteSchedule.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ScheduleRow({
  schedule,
  onDelete,
}: {
  schedule: ScheduledWorkRequestSummary;
  onDelete: () => void;
}) {
  const update = useUpdateSchedule();
  const fire = useFireSchedule();
  const [error, setError] = useState<string | null>(null);

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
      <tr className="border-b border-ink-600 last:border-0">
        <td className="py-2 pr-4">
          <div className="font-medium text-paper-100">{schedule.name}</div>
          <div className="font-mono text-[10px] text-paper-500">{schedule.externalTicketId}</div>
        </td>
        <td className="py-2 pr-4 text-paper-400">
          {schedule.repository.organizationName}/{schedule.repository.repoName}
        </td>
        <td className="py-2 pr-4 font-mono text-xs text-paper-300">{schedule.cronExpression}</td>
        <td className="py-2 pr-4 text-paper-400">
          {schedule.template
            ? `${schedule.template.name} v${schedule.templateVersion ?? '?'}`
            : 'team default'}
        </td>
        <td className="py-2 pr-4">
          <span
            className={`font-mono text-[10px] uppercase tracking-wider ${
              schedule.isActive ? 'text-ember-400' : 'text-paper-500'
            }`}
          >
            {schedule.isActive ? 'active' : 'paused'}
          </span>
          {!schedule.schedule.exists && (
            <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-brick-400">
              missing in temporal
            </span>
          )}
        </td>
        <td className="py-2 pr-4 text-xs text-paper-400">{fmtTime(schedule.schedule.nextRunAt)}</td>
        <td className="py-2 pr-4 text-xs text-paper-400">
          {fmtTime(schedule.schedule.lastRunAt ?? schedule.lastFiredAt)}
        </td>
        <td className="py-2 text-right">
          <div className="flex justify-end gap-1">
            <Button
              disabled={fire.isPending}
              onClick={() => run(() => fire.mutateAsync(schedule.id))}
              size="sm"
              variant="ghost"
            >
              {fire.isPending ? 'Firing…' : 'Fire now'}
            </Button>
            <Button
              disabled={update.isPending}
              onClick={() =>
                run(() => update.mutateAsync({ id: schedule.id, isActive: !schedule.isActive }))
              }
              size="sm"
              variant="ghost"
            >
              {schedule.isActive ? 'Pause' : 'Resume'}
            </Button>
            <Button onClick={onDelete} size="sm" variant="danger">
              Delete
            </Button>
          </div>
        </td>
      </tr>
      {error && (
        <tr>
          <td className="pb-2 text-xs text-brick-400" colSpan={8}>
            {error}
          </td>
        </tr>
      )}
    </>
  );
}

export default function AdminSchedulesPage() {
  const [newOpen, setNewOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledWorkRequestSummary | null>(null);
  const { data: schedules, isLoading } = useSchedules();

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            + New Schedule
          </Button>
        }
        subtitle="Standing automation: each schedule fires the workflow engine on a cron cadence against one repository (e.g. a weekly dependency update). Fires reuse the same synthetic ticket and branch; runs appear in Run History attributed to the schedule's standing work request. Templates are snapshotted when the schedule is saved."
        title="Scheduled Work Requests"
      />

      <Card>
        <CardHeader>
          <CardTitle>All Schedules</CardTitle>
        </CardHeader>
        {isLoading ? (
          <LoadingState />
        ) : !schedules?.length ? (
          <div className="py-8 text-center text-sm text-paper-400">
            No schedules yet. Create one with the button above.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-600">
                <th className="py-2 text-left text-xs text-paper-500">Name</th>
                <th className="py-2 text-left text-xs text-paper-500">Repository</th>
                <th className="py-2 text-left text-xs text-paper-500">Cron</th>
                <th className="py-2 text-left text-xs text-paper-500">Template</th>
                <th className="py-2 text-left text-xs text-paper-500">Status</th>
                <th className="py-2 text-left text-xs text-paper-500">Next fire</th>
                <th className="py-2 text-left text-xs text-paper-500">Last fire</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <ScheduleRow key={s.id} onDelete={() => setDeleteTarget(s)} schedule={s} />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <ScheduleFormModal onClose={() => setNewOpen(false)} open={newOpen} />
      <DeleteConfirmModal onClose={() => setDeleteTarget(null)} schedule={deleteTarget} />
    </div>
  );
}
