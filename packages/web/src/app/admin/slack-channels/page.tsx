'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  type SlackChannel,
  type UpdateSlackChannelBody,
  useCreateSlackChannel,
  useDeleteSlackChannel,
  useSlackChannels,
  useUpdateSlackChannel,
} from '@/hooks/useSlackChannels';
import { useTeams } from '@/hooks/useTeams';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtBudget(
  currentCostUsd: number | undefined,
  budgetCents: number | null | undefined
): string {
  const spent = currentCostUsd !== undefined ? `$${currentCostUsd.toFixed(4)}` : '—';
  const cap = budgetCents != null ? `$${(budgetCents / 100).toFixed(2)}` : 'no cap';
  return `${spent} / ${cap}`;
}

function dollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const num = Number.parseFloat(trimmed);
  if (Number.isNaN(num) || num < 0) {
    return null;
  }
  return Math.round(num * 100);
}

function centsToDisplayDollars(cents: number | null | undefined): string {
  if (cents == null) {
    return '';
  }
  return (cents / 100).toFixed(2);
}

// ── Create modal ─────────────────────────────────────────────────────────────

interface CreateForm {
  slackChannelId: string;
  slackTeamId: string;
  teamId: string;
  name: string;
  agentKey: string;
  ambientEnabled: boolean;
  ambientCron: string;
  budgetDollars: string;
}

const EMPTY_CREATE: CreateForm = {
  agentKey: 'implementer',
  ambientCron: '',
  ambientEnabled: false,
  budgetDollars: '',
  name: '',
  slackChannelId: '',
  slackTeamId: '',
  teamId: '',
};

function CreateChannelModal({ onClose, open }: { onClose: () => void; open: boolean }) {
  const { data: teams } = useTeams();
  const create = useCreateSlackChannel();
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof CreateForm>(key: K, val: CreateForm[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const budgetCents = dollarsToCents(form.budgetDollars);
    if (form.budgetDollars.trim() !== '' && budgetCents === null) {
      setError('Budget must be a non-negative number (e.g. 10.00)');
      return;
    }
    try {
      await create.mutateAsync({
        agentKey: form.agentKey || 'implementer',
        ambientCron: form.ambientCron || null,
        ambientEnabled: form.ambientEnabled,
        monthlyBudgetUsdCents: budgetCents,
        name: form.name || null,
        slackChannelId: form.slackChannelId,
        slackTeamId: form.slackTeamId,
        teamId: form.teamId,
      });
      onClose();
      setForm(EMPTY_CREATE);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create channel');
    }
  }

  return (
    <Modal eyebrow="Admin / Slack" onClose={onClose} open={open} title="Register Slack Channel">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Slack channel ID"
            onChange={(e) => set('slackChannelId', e.target.value)}
            placeholder="C01ABCD1234"
            required
            value={form.slackChannelId}
          />
          <Input
            label="Slack workspace ID"
            onChange={(e) => set('slackTeamId', e.target.value)}
            placeholder="T01WXYZ5678"
            required
            value={form.slackTeamId}
          />
        </div>
        <Input
          label="Display name (optional)"
          onChange={(e) => set('name', e.target.value)}
          placeholder="#engineering-bot"
          value={form.name}
        />
        <Select
          label="Team"
          onChange={(e) => set('teamId', e.target.value)}
          required
          value={form.teamId}
        >
          <option disabled value="">
            Select a team…
          </option>
          {teams?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Input
          hint="Agent role key that handles messages in this channel"
          label="Agent key"
          onChange={(e) => set('agentKey', e.target.value)}
          placeholder="implementer"
          value={form.agentKey}
        />
        <div className="flex items-center gap-3">
          <input
            checked={form.ambientEnabled}
            className="h-4 w-4 accent-ember-400"
            id="create-ambient"
            onChange={(e) => set('ambientEnabled', e.target.checked)}
            type="checkbox"
          />
          <label className="text-sm text-paper-300" htmlFor="create-ambient">
            Ambient mode enabled
          </label>
        </div>
        {form.ambientEnabled && (
          <Input
            hint="Cron expression for ambient digests (e.g. 0 9 * * 1-5)"
            label="Ambient cron"
            onChange={(e) => set('ambientCron', e.target.value)}
            placeholder="0 9 * * 1-5"
            value={form.ambientCron}
          />
        )}
        <Input
          hint="Monthly spend cap in USD (e.g. 50.00). Leave blank for no cap."
          label="Monthly budget ($)"
          min="0"
          onChange={(e) => set('budgetDollars', e.target.value)}
          placeholder="50.00"
          step="0.01"
          type="number"
          value={form.budgetDollars}
        />
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={create.isPending} type="submit" variant="primary">
            {create.isPending ? 'Creating…' : 'Register Channel'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Edit modal ────────────────────────────────────────────────────────────────

interface EditForm {
  name: string;
  agentKey: string;
  ambientEnabled: boolean;
  ambientCron: string;
  budgetDollars: string;
  teamId: string;
}

function buildEditForm(ch: SlackChannel): EditForm {
  return {
    agentKey: ch.agentKey,
    ambientCron: ch.ambientCron ?? '',
    ambientEnabled: ch.ambientEnabled,
    budgetDollars: centsToDisplayDollars(ch.monthlyBudgetUsdCents),
    name: ch.name ?? '',
    teamId: ch.teamId,
  };
}

// Inner form — mounted fresh each time a different channel is selected via `key`
function EditChannelForm({ channel, onClose }: { channel: SlackChannel; onClose: () => void }) {
  const { data: teams } = useTeams();
  const update = useUpdateSlackChannel();
  const [form, setForm] = useState<EditForm>(() => buildEditForm(channel));
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof EditForm>(key: K, val: EditForm[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const budgetCents = dollarsToCents(form.budgetDollars);
    if (form.budgetDollars.trim() !== '' && budgetCents === null) {
      setError('Budget must be a non-negative number (e.g. 10.00)');
      return;
    }
    const body: UpdateSlackChannelBody = {
      agentKey: form.agentKey || undefined,
      ambientCron: form.ambientCron || null,
      ambientEnabled: form.ambientEnabled,
      monthlyBudgetUsdCents: budgetCents,
      name: form.name || null,
      teamId: form.teamId || undefined,
    };
    try {
      await update.mutateAsync({ id: channel.id, ...body });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update channel');
    }
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <Input
        label="Display name"
        onChange={(e) => set('name', e.target.value)}
        placeholder="#engineering-bot"
        value={form.name}
      />
      <Select
        label="Team"
        onChange={(e) => set('teamId', e.target.value)}
        required
        value={form.teamId}
      >
        <option disabled value="">
          Select a team…
        </option>
        {teams?.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
      <Input
        hint="Agent role key that handles messages in this channel"
        label="Agent key"
        onChange={(e) => set('agentKey', e.target.value)}
        placeholder="implementer"
        value={form.agentKey}
      />
      <div className="flex items-center gap-3">
        <input
          checked={form.ambientEnabled}
          className="h-4 w-4 accent-ember-400"
          id="edit-ambient"
          onChange={(e) => set('ambientEnabled', e.target.checked)}
          type="checkbox"
        />
        <label className="text-sm text-paper-300" htmlFor="edit-ambient">
          Ambient mode enabled
        </label>
      </div>
      {form.ambientEnabled && (
        <Input
          hint="Cron expression for ambient digests (e.g. 0 9 * * 1-5)"
          label="Ambient cron"
          onChange={(e) => set('ambientCron', e.target.value)}
          placeholder="0 9 * * 1-5"
          value={form.ambientCron}
        />
      )}
      <Input
        hint="Monthly spend cap in USD (e.g. 50.00). Leave blank to remove the cap."
        label="Monthly budget ($)"
        min="0"
        onChange={(e) => set('budgetDollars', e.target.value)}
        placeholder="50.00"
        step="0.01"
        type="number"
        value={form.budgetDollars}
      />
      {error && <p className="text-xs text-brick-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={update.isPending} type="submit" variant="primary">
          {update.isPending ? 'Saving…' : 'Save Changes'}
        </Button>
      </div>
    </form>
  );
}

function EditChannelModal({
  channel,
  onClose,
}: {
  channel: SlackChannel | null;
  onClose: () => void;
}) {
  return (
    <Modal
      eyebrow="Admin / Slack"
      onClose={onClose}
      open={!!channel}
      subtitle={
        channel ? (
          <span className="font-mono text-[11px]">
            {channel.workspace.slackTeamId} / {channel.slackChannelId}
          </span>
        ) : undefined
      }
      title={channel ? `Edit ${channel.name ?? channel.slackChannelId}` : 'Edit Channel'}
    >
      {channel && <EditChannelForm channel={channel} key={channel.id} onClose={onClose} />}
    </Modal>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function ChannelRow({
  channel,
  onDelete,
  onEdit,
}: {
  channel: SlackChannel;
  onDelete: (ch: SlackChannel) => void;
  onEdit: (ch: SlackChannel) => void;
}) {
  const update = useUpdateSlackChannel();

  async function handleToggleActive() {
    await update.mutateAsync({ id: channel.id, isActive: !channel.isActive });
  }

  const spent = channel.currentMonthUsage?.costUsdAccrued;
  const budget = channel.monthlyBudgetUsdCents;

  return (
    <tr className="border-b border-ink-600 last:border-0">
      <td className="py-3 pr-4">
        <div className="font-mono text-xs text-paper-100">{channel.name ?? '—'}</div>
        <div className="mt-0.5 font-mono text-[11px] text-paper-500">{channel.slackChannelId}</div>
      </td>
      <td className="py-3 pr-4 font-mono text-[11px] text-paper-400">
        {channel.workspace.slackTeamId}
      </td>
      <td className="py-3 pr-4 text-xs text-paper-300">
        {/* team name isn't in the shape but workspace org + teamId are */}
        <span className="font-mono text-[11px]">{channel.teamId.slice(0, 8)}…</span>
      </td>
      <td className="py-3 pr-4 font-mono text-[11px] text-paper-300">{channel.agentKey}</td>
      <td className="py-3 pr-4 text-center">
        {channel.ambientEnabled ? (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            on
            {channel.ambientCron && (
              <span className="text-paper-600"> · {channel.ambientCron}</span>
            )}
          </span>
        ) : (
          <span className="font-mono text-[10px] text-paper-600">off</span>
        )}
      </td>
      <td className="py-3 pr-4 font-mono text-[11px] text-paper-400">{fmtBudget(spent, budget)}</td>
      <td className="py-3 pr-4 text-center">
        <button
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] transition-colors ${
            channel.isActive
              ? 'bg-emerald-400/10 text-emerald-400 hover:bg-emerald-400/20'
              : 'bg-ink-700 text-paper-600 hover:bg-ink-600'
          }`}
          disabled={update.isPending}
          onClick={handleToggleActive}
          type="button"
        >
          {channel.isActive ? 'active' : 'inactive'}
        </button>
      </td>
      <td className="py-3 text-right">
        <div className="flex items-center justify-end gap-2">
          <Button onClick={() => onEdit(channel)} size="sm" variant="secondary">
            Edit
          </Button>
          <Button onClick={() => onDelete(channel)} size="sm" variant="danger">
            Delete
          </Button>
        </div>
      </td>
    </tr>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminSlackChannelsPage() {
  const { data: channels, isLoading } = useSlackChannels();
  const deleteChannel = useDeleteSlackChannel();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SlackChannel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SlackChannel | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete() {
    if (!deleteTarget) {
      return;
    }
    setDeleteError(null);
    try {
      await deleteChannel.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete channel');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Slack Channels</h2>
          <p className="mt-1 text-sm text-paper-400">
            Registered Slack channels that Claude-Tag workflows respond in. Each channel is scoped
            to a team and can override agent key, ambient scheduling, and monthly spend caps.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} variant="primary">
          + Register Channel
        </Button>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle eyebrow="Channels">Registered channels</CardTitle>
          </CardHeader>
          {!channels || channels.length === 0 ? (
            <div className="py-6 text-center text-sm text-paper-400">
              No Slack channels registered yet. Click &ldquo;+ Register Channel&rdquo; to add one.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-600">
                  <th className="pb-2 text-left font-mono text-[10px] uppercase tracking-wider text-paper-500">
                    Channel
                  </th>
                  <th className="pb-2 text-left font-mono text-[10px] uppercase tracking-wider text-paper-500">
                    Workspace
                  </th>
                  <th className="pb-2 text-left font-mono text-[10px] uppercase tracking-wider text-paper-500">
                    Team
                  </th>
                  <th className="pb-2 text-left font-mono text-[10px] uppercase tracking-wider text-paper-500">
                    Agent
                  </th>
                  <th className="pb-2 text-center font-mono text-[10px] uppercase tracking-wider text-paper-500">
                    Ambient
                  </th>
                  <th className="pb-2 text-left font-mono text-[10px] uppercase tracking-wider text-paper-500">
                    Spend / Cap
                  </th>
                  <th className="pb-2 text-center font-mono text-[10px] uppercase tracking-wider text-paper-500">
                    Status
                  </th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {channels.map((ch) => (
                  <ChannelRow
                    channel={ch}
                    key={ch.id}
                    onDelete={setDeleteTarget}
                    onEdit={setEditTarget}
                  />
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      <CreateChannelModal onClose={() => setCreateOpen(false)} open={createOpen} />

      <EditChannelModal channel={editTarget} onClose={() => setEditTarget(null)} />

      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message={
          deleteError ??
          `Delete channel "${deleteTarget?.name ?? deleteTarget?.slackChannelId ?? ''}"? This cannot be undone.`
        }
        onClose={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
        onConfirm={handleDelete}
        open={deleteTarget !== null}
        title="Delete Slack channel"
      />
    </div>
  );
}
