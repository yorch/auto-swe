'use client';

import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useAgentLibrary } from '@/hooks/useAgentLibrary';
import { useTeams } from '@/hooks/useTeams';
import { describeCron } from '@/lib/cronPreview';
import type { ChannelFormErrors, ChannelFormState } from '@/lib/slackChannelForm';

/** A cron input that reads the expression back as plain language, or says what is wrong with it. */
function CronField({
  error,
  id,
  label,
  onChange,
  placeholder,
  value,
}: {
  error?: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  const preview = value.trim() ? describeCron(value) : null;
  return (
    <Input
      error={error ?? (preview && !preview.ok ? preview.error : undefined)}
      hint={
        preview?.ok
          ? `Runs: ${preview.text}`
          : 'Five fields: minute, hour, day of month, month, day of week. Times are UTC.'
      }
      id={id}
      label={label}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      value={value}
    />
  );
}

function OverrideField({
  error,
  hint,
  id,
  label,
  onChange,
  placeholder,
  value,
}: {
  error?: string;
  hint: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <Input
      error={error}
      hint={hint}
      id={id}
      inputMode="numeric"
      label={label}
      min="1"
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      step="1"
      type="number"
      value={value}
    />
  );
}

/**
 * The fields of a Slack channel's configuration, shared by registering a channel and editing its
 * settings: the Slack ids appear only when registering, since they cannot change afterwards.
 */
export function ChannelForm({
  errors,
  form,
  mode,
  onChange,
}: {
  errors: ChannelFormErrors;
  form: ChannelFormState;
  mode: 'create' | 'edit';
  onChange: <K extends keyof ChannelFormState>(key: K, value: ChannelFormState[K]) => void;
}) {
  const { data: teams } = useTeams();
  const { data: agents } = useAgentLibrary({ scope: 'GLOBAL' });

  // One option per agent key; a key the library no longer lists stays selectable so an
  // existing channel is not silently re-pointed.
  const agentOptions = (() => {
    const seen = new Map<string, string>();
    for (const a of agents ?? []) {
      if (a.isActive && !seen.has(a.key)) {
        seen.set(a.key, a.name);
      }
    }
    if (form.agentKey && !seen.has(form.agentKey)) {
      seen.set(form.agentKey, form.agentKey);
    }
    return [...seen.entries()].map(([value, label]) => ({ label, value }));
  })();

  return (
    <div className="space-y-5">
      {mode === 'create' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            error={errors.slackChannelId}
            hint="In Slack: channel details, at the bottom."
            id="slack-channel-id"
            label="Slack channel ID"
            onChange={(e) => onChange('slackChannelId', e.target.value)}
            placeholder="C01ABCD1234"
            required
            value={form.slackChannelId}
          />
          <Input
            error={errors.slackTeamId}
            hint="Identifies the Slack workspace the channel is in."
            id="slack-workspace-id"
            label="Slack workspace ID"
            onChange={(e) => onChange('slackTeamId', e.target.value)}
            placeholder="T01WXYZ5678"
            required
            value={form.slackTeamId}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input
          id="channel-name"
          label="Display name"
          onChange={(e) => onChange('name', e.target.value)}
          placeholder="#engineering-bot"
          value={form.name}
        />
        <Combobox
          emptyMessage="No team matches"
          error={errors.teamId}
          id="channel-team"
          label="Team"
          onChange={(v) => onChange('teamId', v)}
          options={(teams ?? []).map((t) => ({ label: t.name, value: t.id }))}
          placeholder="Choose a team…"
          required
          value={form.teamId}
        />
      </div>
      <Select
        error={errors.agentKey}
        hint="The agent that answers messages in this channel."
        id="channel-agent"
        label="Agent"
        onChange={(v) => onChange('agentKey', v)}
        options={agentOptions}
        placeholder="Choose an agent…"
        value={form.agentKey}
      />

      <Card className="space-y-4 p-4" variant="inset">
        <p className="label-mono">When the assistant speaks up</p>
        <Checkbox
          checked={form.ambientEnabled}
          hint="Posts a scheduled summary of the channel."
          label="Ambient digests"
          onChange={(e) => onChange('ambientEnabled', e.target.checked)}
        />
        {form.ambientEnabled && (
          <CronField
            error={errors.ambientCron}
            id="ambient-cron"
            label="Digest schedule"
            onChange={(v) => onChange('ambientCron', v)}
            placeholder="0 9 * * 1-5"
            value={form.ambientCron}
          />
        )}
        <Checkbox
          checked={form.reactiveEnabled}
          hint="Checks the conversation on a schedule and joins in when it can help."
          label="Reactive replies"
          onChange={(e) => onChange('reactiveEnabled', e.target.checked)}
        />
        {form.reactiveEnabled && (
          <CronField
            error={errors.reactiveCron}
            id="reactive-cron"
            label="Check schedule"
            onChange={(v) => onChange('reactiveCron', v)}
            placeholder="*/5 * * * *"
            value={form.reactiveCron}
          />
        )}
        <Checkbox
          checked={form.followupSessionEnabled}
          hint="Keeps answering in a thread for about 30 minutes without another @mention."
          label="Follow-up sessions"
          onChange={(e) => onChange('followupSessionEnabled', e.target.checked)}
        />
      </Card>

      <Card className="space-y-4 p-4" variant="inset">
        <p className="label-mono">Memory and privacy</p>
        <Checkbox
          checked={form.passiveIngestEnabled}
          hint="Quietly extracts facts from the channel each time the schedule runs."
          label="Learn from the channel"
          onChange={(e) => onChange('passiveIngestEnabled', e.target.checked)}
        />
        <Checkbox
          checked={form.consolidationEnabled}
          hint="Merges similar memories into one on each scheduled run."
          label="Tidy memory"
          onChange={(e) => onChange('consolidationEnabled', e.target.checked)}
        />
        <Checkbox
          checked={form.isPrivate}
          hint="This channel's memory is never shown in other channels."
          label="Private channel"
          onChange={(e) => onChange('isPrivate', e.target.checked)}
        />
        <Checkbox
          checked={form.orgFlaggingEnabled}
          hint="Shows signals from other channels in the organization here."
          label="Organization-wide flagging"
          onChange={(e) => onChange('orgFlaggingEnabled', e.target.checked)}
        />
      </Card>

      <Input
        error={errors.budgetDollars}
        hint="Monthly spend cap in dollars, such as 50.00. Leave blank for no cap."
        id="channel-budget"
        label="Monthly budget ($)"
        min="0"
        onChange={(e) => onChange('budgetDollars', e.target.value)}
        placeholder="50.00"
        step="0.01"
        type="number"
        value={form.budgetDollars}
      />
      <Textarea
        hint="Added to the top of the assistant's instructions in this channel. Leave blank to use the organization default."
        id="channel-persona"
        label="Persona (optional)"
        onChange={(e) => onChange('personaPrompt', e.target.value)}
        placeholder="You are Aria, the platform team's expert. Be concise and technical."
        value={form.personaPrompt}
      />

      <details className="rounded-[10px] border border-ink-500 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-paper-200">
          Timing overrides
        </summary>
        <p className="mt-2 text-xs text-paper-500">
          Leave a field blank to use the built-in value shown inside it.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <OverrideField
            error={errors.reactiveCooldownMinutes}
            hint="Minutes between reactive replies."
            id="reactive-cooldown"
            label="Reactive cooldown (minutes)"
            onChange={(v) => onChange('reactiveCooldownMinutes', v)}
            placeholder="10"
            value={form.reactiveCooldownMinutes}
          />
          <OverrideField
            error={errors.reactiveLookbackMinutes}
            hint="How much recent conversation each check reads."
            id="reactive-lookback"
            label="Reactive lookback (minutes)"
            onChange={(v) => onChange('reactiveLookbackMinutes', v)}
            placeholder="30"
            value={form.reactiveLookbackMinutes}
          />
          <OverrideField
            error={errors.orgFlagCooldownHours}
            hint="Hours between organization-wide flag checks."
            id="org-flag-cooldown"
            label="Flag cooldown (hours)"
            onChange={(v) => onChange('orgFlagCooldownHours', v)}
            placeholder="20"
            value={form.orgFlagCooldownHours}
          />
          <OverrideField
            error={errors.openItemNudgeAfterHours}
            hint="Hours an open item waits before the first reminder."
            id="nudge-after"
            label="First reminder after (hours)"
            onChange={(v) => onChange('openItemNudgeAfterHours', v)}
            placeholder="24"
            value={form.openItemNudgeAfterHours}
          />
          <OverrideField
            error={errors.openItemNudgeCooldownHours}
            hint="Hours between repeat reminders for the same item."
            id="nudge-cooldown"
            label="Repeat reminder every (hours)"
            onChange={(v) => onChange('openItemNudgeCooldownHours', v)}
            placeholder="12"
            value={form.openItemNudgeCooldownHours}
          />
        </div>
      </details>
    </div>
  );
}
