'use client';

import { useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import {
  type ChannelAuditKind,
  type ChannelOpenItemDto,
  type ChannelOpenItemStatus,
  type MemoryItemDto,
  type SlackChannel,
  type UpdateSlackChannelBody,
  useChannelAudit,
  useChannelMemory,
  useChannelOpenItems,
  useCreateSlackChannel,
  useDeleteChannelMemory,
  useDeleteSlackChannel,
  useSlackChannels,
  useUpdateChannelMemory,
  useUpdateChannelOpenItem,
  useUpdateSlackChannel,
} from '@/hooks/useSlackChannels';
import { useTeams } from '@/hooks/useTeams';
import { errMsg } from '@/lib/errors';
import { parseOptionalPositiveInt } from '@/lib/parseIntInput';
import { formatDate, formatRelativeTime } from '@/lib/utils';

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

/** A labelled checkbox row, shared by the create + edit channel forms. */
function CheckboxField({
  checked,
  id,
  label,
  onChange,
}: {
  checked: boolean;
  id: string;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        checked={checked}
        className="h-4 w-4 accent-ember-400"
        id={id}
        onChange={(e) => onChange(e.target.checked)}
        type="checkbox"
      />
      <label className="text-sm text-paper-300" htmlFor={id}>
        {label}
      </label>
    </div>
  );
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
  reactiveEnabled: boolean;
  reactiveCron: string;
  passiveIngestEnabled: boolean;
  isPrivate: boolean;
  orgFlaggingEnabled: boolean;
  followupSessionEnabled: boolean;
  consolidationEnabled: boolean;
  budgetDollars: string;
  personaPrompt: string;
}

const EMPTY_CREATE: CreateForm = {
  agentKey: 'implementer',
  ambientCron: '',
  ambientEnabled: false,
  budgetDollars: '',
  consolidationEnabled: true,
  followupSessionEnabled: false,
  isPrivate: false,
  name: '',
  orgFlaggingEnabled: false,
  passiveIngestEnabled: false,
  personaPrompt: '',
  reactiveCron: '',
  reactiveEnabled: false,
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
        consolidationEnabled: form.consolidationEnabled,
        followupSessionEnabled: form.followupSessionEnabled,
        isPrivate: form.isPrivate,
        monthlyBudgetUsdCents: budgetCents,
        name: form.name || null,
        orgFlaggingEnabled: form.orgFlaggingEnabled,
        passiveIngestEnabled: form.passiveIngestEnabled,
        personaPrompt: form.personaPrompt.trim() || null,
        reactiveCron: form.reactiveCron || null,
        reactiveEnabled: form.reactiveEnabled,
        slackChannelId: form.slackChannelId,
        slackTeamId: form.slackTeamId,
        teamId: form.teamId,
      });
      onClose();
      setForm(EMPTY_CREATE);
    } catch (err) {
      setError(errMsg(err, 'Failed to create channel'));
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
        <div className="flex items-center gap-3">
          <input
            checked={form.reactiveEnabled}
            className="h-4 w-4 accent-ember-400"
            id="create-reactive"
            onChange={(e) => set('reactiveEnabled', e.target.checked)}
            type="checkbox"
          />
          <label className="text-sm text-paper-300" htmlFor="create-reactive">
            Reactive interjection enabled
          </label>
        </div>
        {form.reactiveEnabled && (
          <Input
            hint="Cron poll cadence for reactive interjection (e.g. */5 * * * *)"
            label="Reactive cron"
            onChange={(e) => set('reactiveCron', e.target.value)}
            placeholder="*/5 * * * *"
            value={form.reactiveCron}
          />
        )}
        <div className="flex items-center gap-3">
          <input
            checked={form.passiveIngestEnabled}
            className="h-4 w-4 accent-ember-400"
            id="create-passive-ingest"
            onChange={(e) => set('passiveIngestEnabled', e.target.checked)}
            type="checkbox"
          />
          <label className="text-sm text-paper-300" htmlFor="create-passive-ingest">
            Passive memory ingestion (silent fact extraction on ambient fire)
          </label>
        </div>
        <CheckboxField
          checked={form.isPrivate}
          id="create-is-private"
          label="Private channel (never surface its memory in other channels)"
          onChange={(v) => set('isPrivate', v)}
        />
        <CheckboxField
          checked={form.orgFlaggingEnabled}
          id="create-org-flagging"
          label="Org-wide flagging (surface signals from other channels here)"
          onChange={(v) => set('orgFlaggingEnabled', v)}
        />
        <CheckboxField
          checked={form.followupSessionEnabled}
          id="create-followup-session"
          label="Follow-up sessions (continue a thread without re-@mention for ~30 min)"
          onChange={(v) => set('followupSessionEnabled', v)}
        />
        <CheckboxField
          checked={form.consolidationEnabled}
          id="create-consolidation"
          label="Memory consolidation (compact channel memory on each ambient fire)"
          onChange={(v) => set('consolidationEnabled', v)}
        />
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
        <Textarea
          hint="Persona injected at the top of every system prompt for this channel. Leave blank to inherit the org default."
          label="Persona (optional)"
          onChange={(e) => set('personaPrompt', e.target.value)}
          placeholder="You are Aria, the platform team's expert. Be concise and technical."
          value={form.personaPrompt}
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
  reactiveEnabled: boolean;
  reactiveCron: string;
  passiveIngestEnabled: boolean;
  isPrivate: boolean;
  orgFlaggingEnabled: boolean;
  followupSessionEnabled: boolean;
  consolidationEnabled: boolean;
  budgetDollars: string;
  personaPrompt: string;
  teamId: string;
  reactiveCooldownMinutes: string;
  reactiveLookbackMinutes: string;
  orgFlagCooldownHours: string;
  openItemNudgeAfterHours: string;
  openItemNudgeCooldownHours: string;
}

/** Format a nullable Int override for display in a text/number input: null
 * (use the built-in default) becomes an empty string; the caller shows the
 * default as the input's placeholder instead. */
function intToDisplayString(value: number | null | undefined): string {
  return value == null ? '' : String(value);
}

// Nullable Int override parsing (blank → null = default, invalid → undefined)
// is shared with the mcp-connections timeout inputs.
const parsePositiveIntOverride = parseOptionalPositiveInt;

function buildEditForm(ch: SlackChannel): EditForm {
  return {
    agentKey: ch.agentKey,
    ambientCron: ch.ambientCron ?? '',
    ambientEnabled: ch.ambientEnabled,
    budgetDollars: centsToDisplayDollars(ch.monthlyBudgetUsdCents),
    consolidationEnabled: ch.consolidationEnabled,
    followupSessionEnabled: ch.followupSessionEnabled,
    isPrivate: ch.isPrivate,
    name: ch.name ?? '',
    openItemNudgeAfterHours: intToDisplayString(ch.openItemNudgeAfterHours),
    openItemNudgeCooldownHours: intToDisplayString(ch.openItemNudgeCooldownHours),
    orgFlagCooldownHours: intToDisplayString(ch.orgFlagCooldownHours),
    orgFlaggingEnabled: ch.orgFlaggingEnabled,
    passiveIngestEnabled: ch.passiveIngestEnabled,
    personaPrompt: ch.personaPrompt ?? '',
    reactiveCooldownMinutes: intToDisplayString(ch.reactiveCooldownMinutes),
    reactiveCron: ch.reactiveCron ?? '',
    reactiveEnabled: ch.reactiveEnabled,
    reactiveLookbackMinutes: intToDisplayString(ch.reactiveLookbackMinutes),
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
    const reactiveCooldownMinutes = parsePositiveIntOverride(form.reactiveCooldownMinutes);
    const reactiveLookbackMinutes = parsePositiveIntOverride(form.reactiveLookbackMinutes);
    const orgFlagCooldownHours = parsePositiveIntOverride(form.orgFlagCooldownHours);
    const openItemNudgeAfterHours = parsePositiveIntOverride(form.openItemNudgeAfterHours);
    const openItemNudgeCooldownHours = parsePositiveIntOverride(form.openItemNudgeCooldownHours);
    if (
      reactiveCooldownMinutes === undefined ||
      reactiveLookbackMinutes === undefined ||
      orgFlagCooldownHours === undefined ||
      openItemNudgeAfterHours === undefined ||
      openItemNudgeCooldownHours === undefined
    ) {
      setError('Proactivity cooldowns must be positive whole numbers, or blank to use the default');
      return;
    }
    const body: UpdateSlackChannelBody = {
      agentKey: form.agentKey || undefined,
      ambientCron: form.ambientCron || null,
      ambientEnabled: form.ambientEnabled,
      consolidationEnabled: form.consolidationEnabled,
      followupSessionEnabled: form.followupSessionEnabled,
      isPrivate: form.isPrivate,
      monthlyBudgetUsdCents: budgetCents,
      name: form.name || null,
      openItemNudgeAfterHours,
      openItemNudgeCooldownHours,
      orgFlagCooldownHours,
      orgFlaggingEnabled: form.orgFlaggingEnabled,
      passiveIngestEnabled: form.passiveIngestEnabled,
      personaPrompt: form.personaPrompt.trim() || null,
      reactiveCooldownMinutes,
      reactiveCron: form.reactiveCron || null,
      reactiveEnabled: form.reactiveEnabled,
      reactiveLookbackMinutes,
      teamId: form.teamId || undefined,
    };
    try {
      await update.mutateAsync({ id: channel.id, ...body });
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Failed to update channel'));
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
      <div className="flex items-center gap-3">
        <input
          checked={form.reactiveEnabled}
          className="h-4 w-4 accent-ember-400"
          id="edit-reactive"
          onChange={(e) => set('reactiveEnabled', e.target.checked)}
          type="checkbox"
        />
        <label className="text-sm text-paper-300" htmlFor="edit-reactive">
          Reactive interjection enabled
        </label>
      </div>
      {form.reactiveEnabled && (
        <Input
          hint="Cron poll cadence for reactive interjection (e.g. */5 * * * *)"
          label="Reactive cron"
          onChange={(e) => set('reactiveCron', e.target.value)}
          placeholder="*/5 * * * *"
          value={form.reactiveCron}
        />
      )}
      <div className="flex items-center gap-3">
        <input
          checked={form.passiveIngestEnabled}
          className="h-4 w-4 accent-ember-400"
          id="edit-passive-ingest"
          onChange={(e) => set('passiveIngestEnabled', e.target.checked)}
          type="checkbox"
        />
        <label className="text-sm text-paper-300" htmlFor="edit-passive-ingest">
          Passive memory ingestion (silent fact extraction on ambient fire)
        </label>
      </div>
      <CheckboxField
        checked={form.isPrivate}
        id="edit-is-private"
        label="Private channel (never surface its memory in other channels)"
        onChange={(v) => set('isPrivate', v)}
      />
      <CheckboxField
        checked={form.orgFlaggingEnabled}
        id="edit-org-flagging"
        label="Org-wide flagging (surface signals from other channels here)"
        onChange={(v) => set('orgFlaggingEnabled', v)}
      />
      <CheckboxField
        checked={form.followupSessionEnabled}
        id="edit-followup-session"
        label="Follow-up sessions (continue a thread without re-@mention for ~30 min)"
        onChange={(v) => set('followupSessionEnabled', v)}
      />
      <CheckboxField
        checked={form.consolidationEnabled}
        id="edit-consolidation"
        label="Memory consolidation (compact channel memory on each ambient fire)"
        onChange={(v) => set('consolidationEnabled', v)}
      />
      <div className="space-y-3 rounded border border-ink-600 p-3">
        <p className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
          Proactivity cooldowns
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Input
            hint="Minutes between reactive interjections (default 10)"
            label="Reactive cooldown (min)"
            min="1"
            onChange={(e) => set('reactiveCooldownMinutes', e.target.value)}
            placeholder="10"
            step="1"
            type="number"
            value={form.reactiveCooldownMinutes}
          />
          <Input
            hint="Minutes of channel history scanned per reactive poll (default 30)"
            label="Reactive lookback (min)"
            min="1"
            onChange={(e) => set('reactiveLookbackMinutes', e.target.value)}
            placeholder="30"
            step="1"
            type="number"
            value={form.reactiveLookbackMinutes}
          />
          <Input
            hint="Hours between org-wide flag checks from this channel (default 20)"
            label="Org-flag cooldown (hrs)"
            min="1"
            onChange={(e) => set('orgFlagCooldownHours', e.target.value)}
            placeholder="20"
            step="1"
            type="number"
            value={form.orgFlagCooldownHours}
          />
          <Input
            hint="Hours an open item sits before a nudge (default 24)"
            label="Open-item nudge after (hrs)"
            min="1"
            onChange={(e) => set('openItemNudgeAfterHours', e.target.value)}
            placeholder="24"
            step="1"
            type="number"
            value={form.openItemNudgeAfterHours}
          />
          <Input
            hint="Hours between repeat nudges for the same open item (default 12)"
            label="Open-item nudge cooldown (hrs)"
            min="1"
            onChange={(e) => set('openItemNudgeCooldownHours', e.target.value)}
            placeholder="12"
            step="1"
            type="number"
            value={form.openItemNudgeCooldownHours}
          />
        </div>
        <p className="text-[10px] text-paper-600">
          Leave any field blank to use the built-in default shown as its placeholder.
        </p>
      </div>
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
      <Textarea
        hint="Persona injected at the top of every system prompt for this channel. Leave blank to inherit the org default."
        label="Persona (optional)"
        onChange={(e) => set('personaPrompt', e.target.value)}
        placeholder="You are Aria, the platform team's expert. Be concise and technical."
        value={form.personaPrompt}
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

// ── Memory modal ──────────────────────────────────────────────────────────────

// ── Memory item inline edit form ──────────────────────────────────────────────

interface MemoryEditForm {
  lessonSummary: string;
  rationale: string;
}

function MemoryItemEditForm({
  channelId,
  item,
  onCancel,
  onSaved,
}: {
  channelId: string;
  item: MemoryItemDto;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const updateMemory = useUpdateChannelMemory();
  const [form, setForm] = useState<MemoryEditForm>({
    lessonSummary: item.lessonSummary,
    rationale: item.rationale,
  });
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof MemoryEditForm>(key: K, val: MemoryEditForm[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const lessonSummary = form.lessonSummary.trim();
    const rationale = form.rationale.trim();
    if (!lessonSummary && !rationale) {
      setError('At least one field must be non-empty.');
      return;
    }
    try {
      await updateMemory.mutateAsync({
        channelId,
        lessonSummary: lessonSummary || undefined,
        memoryId: item.id,
        rationale: rationale || undefined,
      });
      onSaved();
    } catch (err) {
      setError(errMsg(err, 'Failed to update memory item'));
    }
  }

  return (
    <form className="mt-2 space-y-2" onSubmit={handleSubmit}>
      <div className="space-y-1">
        <label
          className="block font-mono text-[10px] uppercase tracking-wider text-paper-500"
          htmlFor="mem-edit-lesson"
        >
          Lesson summary
        </label>
        <textarea
          className="w-full rounded border border-ink-500 bg-ink-800 px-2 py-1.5 text-sm text-paper-100 placeholder-paper-600 focus:outline-none focus:ring-1 focus:ring-ember-400"
          id="mem-edit-lesson"
          onChange={(e) => set('lessonSummary', e.target.value)}
          rows={3}
          value={form.lessonSummary}
        />
      </div>
      <div className="space-y-1">
        <label
          className="block font-mono text-[10px] uppercase tracking-wider text-paper-500"
          htmlFor="mem-edit-rationale"
        >
          Rationale
        </label>
        <textarea
          className="w-full rounded border border-ink-500 bg-ink-800 px-2 py-1.5 text-sm text-paper-100 placeholder-paper-600 focus:outline-none focus:ring-1 focus:ring-ember-400"
          id="mem-edit-rationale"
          onChange={(e) => set('rationale', e.target.value)}
          rows={2}
          value={form.rationale}
        />
      </div>
      <p className="text-[10px] text-paper-600">
        Re-embedding happens in the background after saving.
      </p>
      {error && <p className="text-xs text-brick-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={updateMemory.isPending} size="sm" type="submit" variant="primary">
          {updateMemory.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

// ── Memory modal ──────────────────────────────────────────────────────────────

function MemoryModal({ channel, onClose }: { channel: SlackChannel | null; onClose: () => void }) {
  const [showConsolidated, setShowConsolidated] = useState(false);
  const {
    data: items,
    isLoading,
    isError,
    error: loadError,
  } = useChannelMemory(channel?.id ?? null, showConsolidated);
  const deleteMemory = useDeleteChannelMemory();
  const [confirmItem, setConfirmItem] = useState<MemoryItemDto | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function handleDeleteConfirm() {
    if (!confirmItem || !channel) {
      return;
    }
    setDeleteError(null);
    try {
      await deleteMemory.mutateAsync({ channelId: channel.id, memoryId: confirmItem.id });
      setConfirmItem(null);
    } catch (err) {
      setDeleteError(errMsg(err, 'Failed to delete memory item'));
    }
  }

  return (
    <>
      <Modal
        eyebrow="Admin / Slack"
        onClose={onClose}
        open={!!channel}
        size="lg"
        subtitle={
          channel ? (
            <span className="font-mono text-[11px]">
              {channel.workspace.slackTeamId} / {channel.slackChannelId}
            </span>
          ) : undefined
        }
        title={channel ? `Memory — ${channel.name ?? channel.slackChannelId}` : 'Channel Memory'}
      >
        <div className="mb-3 flex items-center gap-2">
          <input
            checked={showConsolidated}
            className="h-4 w-4 rounded border-ink-600 bg-ink-800 text-brand-500"
            id="show-consolidated"
            onChange={(e) => setShowConsolidated(e.target.checked)}
            type="checkbox"
          />
          <label className="text-xs text-paper-400 cursor-pointer" htmlFor="show-consolidated">
            Show consolidated (archived) items
          </label>
        </div>
        <QueryBoundary
          error={loadError}
          isError={isError}
          isLoading={isLoading}
          label="channel memory"
        >
          {!items || items.length === 0 ? (
            <EmptyState className="py-6" title="No memory yet for this channel." />
          ) : (
            <ul className="divide-y divide-ink-600">
              {items.map((item) => {
                const consolidatedAt = item.consolidatedAt;
                const isConsolidated = !!consolidatedAt;
                return (
                  <li className={`py-3 ${isConsolidated ? 'opacity-50' : ''}`} key={item.id}>
                    {!isConsolidated && editingId === item.id ? (
                      <MemoryItemEditForm
                        channelId={channel?.id ?? ''}
                        item={item}
                        onCancel={() => setEditingId(null)}
                        onSaved={() => setEditingId(null)}
                      />
                    ) : (
                      <div className="flex items-start gap-4">
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="text-sm text-paper-100 leading-snug">
                            {item.lessonSummary}
                          </p>
                          <p className="text-xs text-paper-500 leading-snug">{item.rationale}</p>
                          <div className="flex items-center gap-3">
                            {consolidatedAt && (
                              <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-paper-500">
                                consolidated {formatDate(consolidatedAt)}
                              </span>
                            )}
                            {item.agentKey && (
                              <span className="font-mono text-[10px] text-paper-600">
                                {item.agentKey}
                              </span>
                            )}
                            <span className="font-mono text-[10px] text-paper-600">
                              {formatDate(item.createdAt)}
                            </span>
                          </div>
                        </div>
                        {!isConsolidated && (
                          <div className="flex items-center gap-2">
                            <Button
                              onClick={() => {
                                setEditingId(item.id);
                              }}
                              size="sm"
                              variant="secondary"
                            >
                              Edit
                            </Button>
                            <Button
                              onClick={() => {
                                setDeleteError(null);
                                setConfirmItem(item);
                              }}
                              size="sm"
                              variant="danger"
                            >
                              Delete
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </QueryBoundary>
        <div className="flex justify-end pt-2">
          <Button onClick={onClose} type="button" variant="ghost">
            Close
          </Button>
        </div>
      </Modal>

      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message={
          deleteError ??
          `Delete this memory item? This cannot be undone.\n"${confirmItem?.lessonSummary ?? ''}"`
        }
        onClose={() => {
          setConfirmItem(null);
          setDeleteError(null);
        }}
        onConfirm={handleDeleteConfirm}
        open={confirmItem !== null}
        title="Delete memory item"
      />
    </>
  );
}

// ── Open items modal (Gap C) ──────────────────────────────────────────────────

const STATUS_LABELS: Record<ChannelOpenItemStatus, string> = {
  DISMISSED: 'dismissed',
  OPEN: 'open',
  RESOLVED: 'resolved',
};

const STATUS_TONES: Record<ChannelOpenItemStatus, BadgeTone> = {
  DISMISSED: 'muted',
  OPEN: 'amber',
  RESOLVED: 'moss',
};

function OpenItemsModal({
  channel,
  onClose,
}: {
  channel: SlackChannel | null;
  onClose: () => void;
}) {
  const [statusFilter, setStatusFilter] = useState<ChannelOpenItemStatus | 'all'>('OPEN');
  const {
    data: items,
    isLoading,
    isError,
    error: loadError,
  } = useChannelOpenItems(channel?.id ?? null, statusFilter);
  const updateItem = useUpdateChannelOpenItem();
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleStatus(item: ChannelOpenItemDto, status: ChannelOpenItemStatus) {
    if (!channel) {
      return;
    }
    setActionError(null);
    try {
      await updateItem.mutateAsync({ channelId: channel.id, itemId: item.id, status });
    } catch (err) {
      setActionError(errMsg(err, 'Failed to update item'));
    }
  }

  return (
    <Modal
      eyebrow="Admin / Slack"
      onClose={onClose}
      open={channel !== null}
      title={channel ? `Open Items — ${channel.name ?? channel.slackChannelId}` : 'Open Items'}
    >
      <div className="space-y-4">
        <div className="flex gap-2">
          {(['OPEN', 'RESOLVED', 'DISMISSED', 'all'] as const).map((s) => (
            <button
              className={`rounded px-2 py-0.5 font-mono text-[10px] transition-colors ${
                statusFilter === s
                  ? 'bg-ink-600 text-paper-100'
                  : 'text-paper-500 hover:text-paper-300'
              }`}
              key={s}
              onClick={() => setStatusFilter(s)}
              type="button"
            >
              {s === 'all' ? 'all' : STATUS_LABELS[s]}
            </button>
          ))}
        </div>

        {actionError && (
          <div className="rounded bg-brick-400/15 px-3 py-2 font-mono text-xs text-brick-400">
            {actionError}
          </div>
        )}

        <QueryBoundary error={loadError} isError={isError} isLoading={isLoading} label="open items">
          {!items || items.length === 0 ? (
            <p className="py-4 text-center text-sm text-paper-500">
              No {statusFilter !== 'all' ? statusFilter.toLowerCase() : ''} items for this channel.
            </p>
          ) : (
            <div className="space-y-2">
              {items.map((item) => (
                <div className="rounded border border-ink-600 bg-ink-800 p-3 text-sm" key={item.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <p className="text-paper-100">{item.description}</p>
                      <div className="mt-1 flex flex-wrap gap-2 font-mono text-[10px] text-paper-500">
                        <Badge tone={STATUS_TONES[item.status]} variant="text">
                          {STATUS_LABELS[item.status]}
                        </Badge>
                        <span>·</span>
                        <span>{formatRelativeTime(item.createdAt)}</span>
                        {item.ownerUserId && (
                          <>
                            <span>·</span>
                            <span>owner: {item.ownerUserId}</span>
                          </>
                        )}
                        {item.lastNudgedAt && (
                          <>
                            <span>·</span>
                            <span>nudged {formatRelativeTime(item.lastNudgedAt)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {item.status === 'OPEN' && (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          disabled={updateItem.isPending}
                          onClick={() => handleStatus(item, 'RESOLVED')}
                          size="sm"
                          variant="secondary"
                        >
                          Resolve
                        </Button>
                        <Button
                          disabled={updateItem.isPending}
                          onClick={() => handleStatus(item, 'DISMISSED')}
                          size="sm"
                          variant="danger"
                        >
                          Dismiss
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </QueryBoundary>
      </div>
    </Modal>
  );
}

// ── Audit modal (Gap J) ─────────────────────────────────────────────────────────

const AUDIT_KIND_TONES: Record<ChannelAuditKind, BadgeTone> = {
  ambient: 'moss',
  mention: 'dust',
  reactive: 'amber',
};

function AuditModal({ channel, onClose }: { channel: SlackChannel | null; onClose: () => void }) {
  const [kindFilter, setKindFilter] = useState<ChannelAuditKind | 'all'>('all');
  const { data: entries, isLoading } = useChannelAudit(channel?.id ?? null, kindFilter);

  return (
    <Modal
      eyebrow="Admin / Slack"
      onClose={onClose}
      open={channel !== null}
      title={channel ? `Audit — ${channel.name ?? channel.slackChannelId}` : 'Audit'}
    >
      <div className="space-y-4">
        <p className="text-xs text-paper-500">
          Who triggered the assistant in this channel, what they asked, and what it touched. Each
          entry links to the full run trace.
        </p>
        <div className="flex gap-2">
          {(['all', 'mention', 'ambient', 'reactive'] as const).map((k) => (
            <button
              className={`rounded px-2 py-0.5 font-mono text-[10px] transition-colors ${
                kindFilter === k
                  ? 'bg-ink-600 text-paper-100'
                  : 'text-paper-500 hover:text-paper-300'
              }`}
              key={k}
              onClick={() => setKindFilter(k)}
              type="button"
            >
              {k}
            </button>
          ))}
        </div>

        {isLoading ? (
          <LoadingState />
        ) : !entries || entries.length === 0 ? (
          <p className="py-4 text-center text-sm text-paper-500">
            No {kindFilter !== 'all' ? kindFilter : ''} activity recorded for this channel yet.
          </p>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div className="rounded border border-ink-600 bg-ink-800 p-3 text-sm" key={e.runId}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <p className="text-paper-100">
                      {e.userText ?? (
                        <span className="italic text-paper-500">
                          {e.kind === 'mention' ? '(no message captured)' : 'proactive — no user'}
                        </span>
                      )}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2 font-mono text-[10px] text-paper-500">
                      <Badge tone={AUDIT_KIND_TONES[e.kind]} variant="text">
                        {e.kind}
                      </Badge>
                      <span>·</span>
                      <span>{e.userSlackId ? `by ${e.userSlackId}` : 'system'}</span>
                      <span>·</span>
                      <span>{formatRelativeTime(e.createdAt)}</span>
                      <span>·</span>
                      <span>{e.status}</span>
                      <span>·</span>
                      <span>
                        {typeof e.costUsd === 'number' ? `$${e.costUsd.toFixed(4)}` : '—'}
                      </span>
                      <span>·</span>
                      <span>
                        {e.tokensInput}/{e.tokensOutput} tok
                      </span>
                    </div>
                  </div>
                  <a
                    className="shrink-0 font-mono text-[10px] text-ember-400 hover:underline"
                    href={`/runs/${e.runId}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    trace →
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function ChannelRow({
  channel,
  onAudit,
  onDelete,
  onEdit,
  onMemory,
  onOpenItems,
}: {
  channel: SlackChannel;
  onAudit: (ch: SlackChannel) => void;
  onDelete: (ch: SlackChannel) => void;
  onEdit: (ch: SlackChannel) => void;
  onMemory: (ch: SlackChannel) => void;
  onOpenItems: (ch: SlackChannel) => void;
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
        <div className="flex flex-col items-center gap-0.5">
          {channel.ambientEnabled ? (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-moss-400">
              <span className="h-1.5 w-1.5 rounded-full bg-moss-400" />
              ambient
              {channel.ambientCron && (
                <span className="text-paper-600"> · {channel.ambientCron}</span>
              )}
            </span>
          ) : (
            <span className="font-mono text-[10px] text-paper-600">ambient off</span>
          )}
          {channel.reactiveEnabled ? (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-dust-400">
              <span className="h-1.5 w-1.5 rounded-full bg-dust-400" />
              reactive
              {channel.reactiveCron && (
                <span className="text-paper-600"> · {channel.reactiveCron}</span>
              )}
            </span>
          ) : (
            <span className="font-mono text-[10px] text-paper-600">reactive off</span>
          )}
          {channel.isPrivate && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-amber-400">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              private
            </span>
          )}
        </div>
      </td>
      <td className="py-3 pr-4 font-mono text-[11px] text-paper-400">{fmtBudget(spent, budget)}</td>
      <td className="py-3 pr-4 text-center">
        <button
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] transition-colors ${
            channel.isActive
              ? 'bg-moss-400/10 text-moss-400 hover:bg-moss-400/20'
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
          <Button onClick={() => onOpenItems(channel)} size="sm" variant="secondary">
            Open Items
          </Button>
          <Button onClick={() => onAudit(channel)} size="sm" variant="secondary">
            Audit
          </Button>
          <Button onClick={() => onMemory(channel)} size="sm" variant="secondary">
            Memory
          </Button>
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
  const [memoryTarget, setMemoryTarget] = useState<SlackChannel | null>(null);
  const [openItemsTarget, setOpenItemsTarget] = useState<SlackChannel | null>(null);
  const [auditTarget, setAuditTarget] = useState<SlackChannel | null>(null);
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
      setDeleteError(errMsg(err, 'Failed to delete channel'));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={() => setCreateOpen(true)} variant="primary">
            + Register Channel
          </Button>
        }
        subtitle="Registered Slack channels that channel-assistant workflows respond in. Each channel is scoped to a team and can override agent key, ambient scheduling, and monthly spend caps."
        title="Slack Channels"
      />

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
                    onAudit={setAuditTarget}
                    onDelete={setDeleteTarget}
                    onEdit={setEditTarget}
                    onMemory={setMemoryTarget}
                    onOpenItems={setOpenItemsTarget}
                  />
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      <CreateChannelModal onClose={() => setCreateOpen(false)} open={createOpen} />

      <EditChannelModal channel={editTarget} onClose={() => setEditTarget(null)} />

      <MemoryModal channel={memoryTarget} onClose={() => setMemoryTarget(null)} />

      <OpenItemsModal channel={openItemsTarget} onClose={() => setOpenItemsTarget(null)} />

      <AuditModal channel={auditTarget} onClose={() => setAuditTarget(null)} />

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
