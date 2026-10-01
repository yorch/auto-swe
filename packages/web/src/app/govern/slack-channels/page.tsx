'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { Textarea } from '@/components/ui/Textarea';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
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
import { formatCents, formatCost, formatDate, formatRelativeTime, formatTokens } from '@/lib/utils';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Spend is a computed model cost in USD; the cap is stored in cents. */
function fmtBudget(
  currentCostUsd: number | undefined,
  budgetCents: number | null | undefined
): string {
  const spent = currentCostUsd !== undefined ? formatCost(currentCostUsd) : '—';
  const cap = budgetCents != null ? formatCents(budgetCents) : 'no cap';
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
    <Modal onClose={onClose} open={open} title="Register Slack channel">
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
        <Checkbox
          checked={form.ambientEnabled}
          label="Ambient mode enabled"
          onChange={(e) => set('ambientEnabled', e.target.checked)}
        />
        {form.ambientEnabled && (
          <Input
            hint="Cron expression for ambient digests (e.g. 0 9 * * 1-5)"
            label="Ambient cron"
            onChange={(e) => set('ambientCron', e.target.value)}
            placeholder="0 9 * * 1-5"
            value={form.ambientCron}
          />
        )}
        <Checkbox
          checked={form.reactiveEnabled}
          label="Reactive interjection enabled"
          onChange={(e) => set('reactiveEnabled', e.target.checked)}
        />
        {form.reactiveEnabled && (
          <Input
            hint="Cron poll cadence for reactive interjection (e.g. */5 * * * *)"
            label="Reactive cron"
            onChange={(e) => set('reactiveCron', e.target.value)}
            placeholder="*/5 * * * *"
            value={form.reactiveCron}
          />
        )}
        <Checkbox
          checked={form.passiveIngestEnabled}
          label="Passive memory ingestion (silent fact extraction on ambient fire)"
          onChange={(e) => set('passiveIngestEnabled', e.target.checked)}
        />
        <Checkbox
          checked={form.isPrivate}
          label="Private channel (never surface its memory in other channels)"
          onChange={(e) => set('isPrivate', e.target.checked)}
        />
        <Checkbox
          checked={form.orgFlaggingEnabled}
          label="Org-wide flagging (surface signals from other channels here)"
          onChange={(e) => set('orgFlaggingEnabled', e.target.checked)}
        />
        <Checkbox
          checked={form.followupSessionEnabled}
          label="Follow-up sessions (continue a thread without re-@mention for ~30 min)"
          onChange={(e) => set('followupSessionEnabled', e.target.checked)}
        />
        <Checkbox
          checked={form.consolidationEnabled}
          label="Memory consolidation (compact channel memory on each ambient fire)"
          onChange={(e) => set('consolidationEnabled', e.target.checked)}
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
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          isPending={create.isPending}
          onCancel={onClose}
          pendingLabel="Registering…"
          submitLabel="Register channel"
        />
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
      <Checkbox
        checked={form.ambientEnabled}
        label="Ambient mode enabled"
        onChange={(e) => set('ambientEnabled', e.target.checked)}
      />
      {form.ambientEnabled && (
        <Input
          hint="Cron expression for ambient digests (e.g. 0 9 * * 1-5)"
          label="Ambient cron"
          onChange={(e) => set('ambientCron', e.target.value)}
          placeholder="0 9 * * 1-5"
          value={form.ambientCron}
        />
      )}
      <Checkbox
        checked={form.reactiveEnabled}
        label="Reactive interjection enabled"
        onChange={(e) => set('reactiveEnabled', e.target.checked)}
      />
      {form.reactiveEnabled && (
        <Input
          hint="Cron poll cadence for reactive interjection (e.g. */5 * * * *)"
          label="Reactive cron"
          onChange={(e) => set('reactiveCron', e.target.value)}
          placeholder="*/5 * * * *"
          value={form.reactiveCron}
        />
      )}
      <Checkbox
        checked={form.passiveIngestEnabled}
        label="Passive memory ingestion (silent fact extraction on ambient fire)"
        onChange={(e) => set('passiveIngestEnabled', e.target.checked)}
      />
      <Checkbox
        checked={form.isPrivate}
        label="Private channel (never surface its memory in other channels)"
        onChange={(e) => set('isPrivate', e.target.checked)}
      />
      <Checkbox
        checked={form.orgFlaggingEnabled}
        label="Org-wide flagging (surface signals from other channels here)"
        onChange={(e) => set('orgFlaggingEnabled', e.target.checked)}
      />
      <Checkbox
        checked={form.followupSessionEnabled}
        label="Follow-up sessions (continue a thread without re-@mention for ~30 min)"
        onChange={(e) => set('followupSessionEnabled', e.target.checked)}
      />
      <Checkbox
        checked={form.consolidationEnabled}
        label="Memory consolidation (compact channel memory on each ambient fire)"
        onChange={(e) => set('consolidationEnabled', e.target.checked)}
      />
      <Card className="space-y-3 p-3" variant="inset">
        <p className="label-mono">Proactivity cooldowns</p>
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
      </Card>
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
      {error && <Alert>{error}</Alert>}
      <ModalFooter
        isPending={update.isPending}
        onCancel={onClose}
        pendingLabel="Saving…"
        submitLabel="Save changes"
      />
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
      onClose={onClose}
      open={!!channel}
      subtitle={
        channel ? (
          <span className="font-mono text-[11px]">
            {channel.workspace.slackTeamId} / {channel.slackChannelId}
          </span>
        ) : undefined
      }
      title={channel ? `Edit ${channel.name ?? channel.slackChannelId}` : 'Edit channel'}
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
      <Textarea
        compact
        id="mem-edit-lesson"
        label="Lesson summary"
        onChange={(e) => set('lessonSummary', e.target.value)}
        rows={3}
        value={form.lessonSummary}
      />
      <Textarea
        compact
        id="mem-edit-rationale"
        label="Rationale"
        onChange={(e) => set('rationale', e.target.value)}
        rows={2}
        value={form.rationale}
      />
      <p className="text-[10px] text-paper-600">
        Re-embedding happens in the background after saving.
      </p>
      {error && <Alert>{error}</Alert>}
      <ModalFooter
        isPending={updateMemory.isPending}
        onCancel={onCancel}
        pendingLabel="Saving…"
        submitLabel="Save"
      />
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
  const [editingId, setEditingId] = useState<string | null>(null);

  // Rejections surface inside the ConfirmModal, under its message.
  async function handleDeleteConfirm() {
    if (!confirmItem || !channel) {
      return;
    }
    await deleteMemory.mutateAsync({ channelId: channel.id, memoryId: confirmItem.id });
  }

  return (
    <>
      <Modal
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
        title={channel ? `Memory — ${channel.name ?? channel.slackChannelId}` : 'Channel memory'}
      >
        <Checkbox
          checked={showConsolidated}
          className="mb-3"
          label="Show consolidated (archived) items"
          onChange={(e) => setShowConsolidated(e.target.checked)}
        />
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
                              <Badge tone="muted">consolidated {formatDate(consolidatedAt)}</Badge>
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
                            <Button onClick={() => setConfirmItem(item)} size="sm" variant="danger">
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
        message={`Delete this memory item? This cannot be undone.\n"${confirmItem?.lessonSummary ?? ''}"`}
        onClose={() => setConfirmItem(null)}
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
      onClose={onClose}
      open={channel !== null}
      title={channel ? `Open items — ${channel.name ?? channel.slackChannelId}` : 'Open items'}
    >
      <div className="space-y-4">
        <SegmentedControl
          ariaLabel="Filter open items by status"
          onChange={setStatusFilter}
          options={(['OPEN', 'RESOLVED', 'DISMISSED', 'all'] as const).map((s) => ({
            label: s === 'all' ? 'all' : STATUS_LABELS[s],
            value: s,
          }))}
          value={statusFilter}
        />

        {actionError && <Alert>{actionError}</Alert>}

        <QueryBoundary error={loadError} isError={isError} isLoading={isLoading} label="open items">
          {!items || items.length === 0 ? (
            <EmptyState
              className="py-4"
              title={`No ${statusFilter !== 'all' ? statusFilter.toLowerCase() : ''} items for this channel.`}
            />
          ) : (
            <div className="space-y-2">
              {items.map((item) => (
                <Card className="p-3 text-sm" key={item.id} variant="inset">
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
                </Card>
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
  const {
    data: entries,
    error: loadError,
    isError,
    isLoading,
  } = useChannelAudit(channel?.id ?? null, kindFilter);

  return (
    <Modal
      onClose={onClose}
      open={channel !== null}
      title={channel ? `Audit — ${channel.name ?? channel.slackChannelId}` : 'Audit'}
    >
      <div className="space-y-4">
        <p className="text-xs text-paper-500">
          Who triggered the assistant in this channel, what they asked, and what it touched. Each
          entry links to the full run trace.
        </p>
        <SegmentedControl
          ariaLabel="Filter audit entries by trigger"
          onChange={setKindFilter}
          options={(['all', 'mention', 'ambient', 'reactive'] as const).map((k) => ({
            label: k,
            value: k,
          }))}
          value={kindFilter}
        />

        {isLoading || isError ? (
          <QueryBoundary
            error={loadError}
            isError={isError}
            isLoading={isLoading}
            label="audit entries"
          />
        ) : !entries || entries.length === 0 ? (
          <EmptyState
            className="py-4"
            title={`No ${kindFilter !== 'all' ? kindFilter : ''} activity recorded for this channel yet.`}
          />
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <Card className="p-3 text-sm" key={e.runId} variant="inset">
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
                      <span>{formatCost(typeof e.costUsd === 'number' ? e.costUsd : null)}</span>
                      <span>·</span>
                      <span>
                        {formatTokens(e.tokensInput)}/{formatTokens(e.tokensOutput)} tok
                      </span>
                    </div>
                  </div>
                  <Link
                    className="shrink-0 font-mono text-[10px] text-ember-400 hover:underline"
                    href={`/runs/${e.runId}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    trace →
                  </Link>
                </div>
              </Card>
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
  teamName,
}: {
  channel: SlackChannel;
  onAudit: (ch: SlackChannel) => void;
  onDelete: (ch: SlackChannel) => void;
  onEdit: (ch: SlackChannel) => void;
  onMemory: (ch: SlackChannel) => void;
  onOpenItems: (ch: SlackChannel) => void;
  teamName: string | undefined;
}) {
  const update = useUpdateSlackChannel();
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Deactivating stops the assistant in a live channel, so it confirms first;
  // reactivating does not.
  async function handleToggleActive() {
    setToggleError(null);
    if (channel.isActive) {
      setConfirmDeactivate(true);
      return;
    }
    try {
      await update.mutateAsync({ id: channel.id, isActive: true });
    } catch (err) {
      setToggleError(errMsg(err, 'Failed to activate channel'));
    }
  }

  const spent = channel.currentMonthUsage?.costUsdAccrued;
  const budget = channel.monthlyBudgetUsdCents;

  return (
    <TRow>
      <Td className="px-4 py-3">
        <div className="font-mono text-xs text-paper-100">{channel.name ?? '—'}</div>
        <div className="mt-0.5 font-mono text-[11px] text-paper-500">{channel.slackChannelId}</div>
      </Td>
      <Td className="px-4 py-3 font-mono text-[11px] text-paper-400">
        {channel.workspace.slackTeamId}
      </Td>
      <Td className="px-4 py-3 text-xs text-paper-300">
        {teamName ?? (
          <span className="font-mono text-[11px]" title={channel.teamId}>
            {channel.teamId.slice(0, 8)}…
          </span>
        )}
      </Td>
      <Td className="px-4 py-3 font-mono text-[11px] text-paper-300">{channel.agentKey}</Td>
      <Td align="center" className="px-4 py-3">
        <div className="flex flex-col items-center gap-0.5">
          {channel.ambientEnabled ? (
            <Badge dot tone="moss" variant="text">
              ambient
              {channel.ambientCron && (
                <span className="text-paper-600"> · {channel.ambientCron}</span>
              )}
            </Badge>
          ) : (
            <Badge tone="muted" variant="text">
              ambient off
            </Badge>
          )}
          {channel.reactiveEnabled ? (
            <Badge dot tone="dust" variant="text">
              reactive
              {channel.reactiveCron && (
                <span className="text-paper-600"> · {channel.reactiveCron}</span>
              )}
            </Badge>
          ) : (
            <Badge tone="muted" variant="text">
              reactive off
            </Badge>
          )}
          {channel.isPrivate && (
            <Badge dot tone="amber" variant="text">
              private
            </Badge>
          )}
        </div>
      </Td>
      <Td className="px-4 py-3 font-mono text-[11px] text-paper-400">{fmtBudget(spent, budget)}</Td>
      <Td align="center" className="px-4 py-3">
        <div className="flex justify-center">
          <ToggleSwitch
            checked={channel.isActive}
            disabled={update.isPending}
            onChange={handleToggleActive}
            title={
              channel.isActive ? 'Active — click to deactivate' : 'Inactive — click to activate'
            }
          />
        </div>
        {toggleError && <Alert className="mt-1 text-left text-xs">{toggleError}</Alert>}
        <ConfirmModal
          confirmLabel="Deactivate"
          dangerous
          message={`The assistant stops responding in "${channel.name ?? channel.slackChannelId}" until the channel is activated again.`}
          onClose={() => setConfirmDeactivate(false)}
          onConfirm={async () => {
            await update.mutateAsync({ id: channel.id, isActive: false });
          }}
          open={confirmDeactivate}
          title="Deactivate channel?"
        />
      </Td>
      <Td align="right" className="px-4 py-3">
        <div className="flex items-center justify-end gap-2">
          <Button onClick={() => onOpenItems(channel)} size="sm" variant="secondary">
            Open items
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
      </Td>
    </TRow>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function GovernSlackChannelsPage() {
  const { data: channels, error: loadError, isError, isLoading } = useSlackChannels();
  const { data: teams } = useTeams();
  const deleteChannel = useDeleteSlackChannel();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SlackChannel | null>(null);
  const [memoryTarget, setMemoryTarget] = useState<SlackChannel | null>(null);
  const [openItemsTarget, setOpenItemsTarget] = useState<SlackChannel | null>(null);
  const [auditTarget, setAuditTarget] = useState<SlackChannel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SlackChannel | null>(null);

  const teamNames = new Map(teams?.map((t) => [t.id, t.name]));

  // Rejections surface inside the ConfirmModal, under its message.
  async function handleDelete() {
    if (!deleteTarget) {
      return;
    }
    await deleteChannel.mutateAsync(deleteTarget.id);
  }

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <Button onClick={() => setCreateOpen(true)} variant="primary">
            Register channel
          </Button>
        }
        chapter="§ Govern"
        subtitle="Registered Slack channels that channel-assistant workflows respond in. Each channel is scoped to a team and can override agent key, ambient scheduling, and monthly spend caps."
        title="Slack channels"
      />

      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="Slack channels"
      >
        <Card>
          <CardHeader>
            <CardTitle eyebrow="Channels">Registered channels</CardTitle>
          </CardHeader>
          <Table>
            <THead>
              <Th>Channel</Th>
              <Th>Workspace</Th>
              <Th>Team</Th>
              <Th>Agent</Th>
              <Th align="center">Ambient</Th>
              <Th>Spend / Cap</Th>
              <Th align="center">Status</Th>
              <Th />
            </THead>
            <tbody>
              {!channels || channels.length === 0 ? (
                <TableStatusRow colSpan={8}>
                  <EmptyState
                    hint="Click “Register channel” to add one."
                    title="No Slack channels registered yet."
                  />
                </TableStatusRow>
              ) : (
                channels.map((ch) => (
                  <ChannelRow
                    channel={ch}
                    key={ch.id}
                    onAudit={setAuditTarget}
                    onDelete={setDeleteTarget}
                    onEdit={setEditTarget}
                    onMemory={setMemoryTarget}
                    onOpenItems={setOpenItemsTarget}
                    teamName={teamNames.get(ch.teamId)}
                  />
                ))
              )}
            </tbody>
          </Table>
        </Card>
      </QueryBoundary>

      <CreateChannelModal onClose={() => setCreateOpen(false)} open={createOpen} />

      <EditChannelModal channel={editTarget} onClose={() => setEditTarget(null)} />

      <MemoryModal channel={memoryTarget} onClose={() => setMemoryTarget(null)} />

      <OpenItemsModal channel={openItemsTarget} onClose={() => setOpenItemsTarget(null)} />

      <AuditModal channel={auditTarget} onClose={() => setAuditTarget(null)} />

      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message={`Delete channel "${deleteTarget?.name ?? deleteTarget?.slackChannelId ?? ''}"? This cannot be undone.`}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        open={deleteTarget !== null}
        title="Delete Slack channel"
      />
    </div>
  );
}
