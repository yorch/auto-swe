import type {
  CreateSlackChannelBody,
  SlackChannel,
  UpdateSlackChannelBody,
} from '@/hooks/useSlackChannels';
import { describeCron } from '@/lib/cronPreview';
import { parseOptionalPositiveInt } from '@/lib/parseIntInput';

/**
 * The one shape the register and settings forms edit. Numbers and cron stay text while typing and
 * are parsed and validated on save; a blank override means "use the built-in default".
 */
export interface ChannelFormState {
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
  reactiveCooldownMinutes: string;
  reactiveLookbackMinutes: string;
  orgFlagCooldownHours: string;
  openItemNudgeAfterHours: string;
  openItemNudgeCooldownHours: string;
}

export type ChannelFormErrors = Partial<Record<keyof ChannelFormState, string>>;

export const DEFAULT_CHANNEL_AGENT = 'implementer';

export function emptyChannelForm(): ChannelFormState {
  return {
    agentKey: DEFAULT_CHANNEL_AGENT,
    ambientCron: '',
    ambientEnabled: false,
    budgetDollars: '',
    consolidationEnabled: true,
    followupSessionEnabled: false,
    isPrivate: false,
    name: '',
    openItemNudgeAfterHours: '',
    openItemNudgeCooldownHours: '',
    orgFlagCooldownHours: '',
    orgFlaggingEnabled: false,
    passiveIngestEnabled: false,
    personaPrompt: '',
    reactiveCooldownMinutes: '',
    reactiveCron: '',
    reactiveEnabled: false,
    reactiveLookbackMinutes: '',
    slackChannelId: '',
    slackTeamId: '',
    teamId: '',
  };
}

const intText = (value: number | null | undefined) => (value == null ? '' : String(value));

export function channelToForm(ch: SlackChannel): ChannelFormState {
  return {
    agentKey: ch.agentKey,
    ambientCron: ch.ambientCron ?? '',
    ambientEnabled: ch.ambientEnabled,
    budgetDollars:
      ch.monthlyBudgetUsdCents == null ? '' : (ch.monthlyBudgetUsdCents / 100).toFixed(2),
    consolidationEnabled: ch.consolidationEnabled,
    followupSessionEnabled: ch.followupSessionEnabled,
    isPrivate: ch.isPrivate,
    name: ch.name ?? '',
    openItemNudgeAfterHours: intText(ch.openItemNudgeAfterHours),
    openItemNudgeCooldownHours: intText(ch.openItemNudgeCooldownHours),
    orgFlagCooldownHours: intText(ch.orgFlagCooldownHours),
    orgFlaggingEnabled: ch.orgFlaggingEnabled,
    passiveIngestEnabled: ch.passiveIngestEnabled,
    personaPrompt: ch.personaPrompt ?? '',
    reactiveCooldownMinutes: intText(ch.reactiveCooldownMinutes),
    reactiveCron: ch.reactiveCron ?? '',
    reactiveEnabled: ch.reactiveEnabled,
    reactiveLookbackMinutes: intText(ch.reactiveLookbackMinutes),
    slackChannelId: ch.slackChannelId,
    slackTeamId: ch.workspace.slackTeamId,
    teamId: ch.teamId,
  };
}

/** Dollars typed by a person to the cents the API stores; `null` for blank, `undefined` for invalid. */
export function dollarsToCents(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) {
    return undefined;
  }
  return Math.round(num * 100);
}

const OVERRIDE_FIELDS = [
  'reactiveCooldownMinutes',
  'reactiveLookbackMinutes',
  'orgFlagCooldownHours',
  'openItemNudgeAfterHours',
  'openItemNudgeCooldownHours',
] as const;

export function validateChannelForm(
  form: ChannelFormState,
  mode: 'create' | 'edit'
): ChannelFormErrors {
  const errors: ChannelFormErrors = {};
  if (mode === 'create') {
    if (!form.slackChannelId.trim()) {
      errors.slackChannelId = 'Enter the Slack channel ID.';
    }
    if (!form.slackTeamId.trim()) {
      errors.slackTeamId = 'Enter the Slack workspace ID.';
    }
  }
  if (!form.teamId) {
    errors.teamId = 'Choose the team this channel belongs to.';
  }
  if (!form.agentKey) {
    errors.agentKey = 'Choose the agent that answers in this channel.';
  }
  for (const [enabled, field, label] of [
    [form.ambientEnabled, 'ambientCron', 'Ambient schedule'],
    [form.reactiveEnabled, 'reactiveCron', 'Reactive schedule'],
  ] as const) {
    const value = form[field].trim();
    if (enabled && value) {
      const preview = describeCron(value);
      if (!preview.ok) {
        errors[field] = preview.error;
      }
    } else if (enabled && !value) {
      errors[field] = `${label} needs a cron expression while it is switched on.`;
    }
  }
  if (dollarsToCents(form.budgetDollars) === undefined) {
    errors.budgetDollars = 'Enter a dollar amount of zero or more, such as 50.00.';
  }
  for (const field of OVERRIDE_FIELDS) {
    if (parseOptionalPositiveInt(form[field]) === undefined) {
      errors[field] = 'Use a whole number of 1 or more, or leave blank for the default.';
    }
  }
  return errors;
}

/** The schedule is stored only while its feature is on; blank means none. */
function cronFor(enabled: boolean, value: string): string | null {
  return enabled && value.trim() ? value.trim() : null;
}

/** Call only after `validateChannelForm` returned no errors. */
export function formToCreateBody(form: ChannelFormState): CreateSlackChannelBody {
  return {
    agentKey: form.agentKey || DEFAULT_CHANNEL_AGENT,
    ambientCron: cronFor(form.ambientEnabled, form.ambientCron),
    ambientEnabled: form.ambientEnabled,
    consolidationEnabled: form.consolidationEnabled,
    followupSessionEnabled: form.followupSessionEnabled,
    isPrivate: form.isPrivate,
    monthlyBudgetUsdCents: dollarsToCents(form.budgetDollars) ?? null,
    name: form.name.trim() || null,
    orgFlaggingEnabled: form.orgFlaggingEnabled,
    passiveIngestEnabled: form.passiveIngestEnabled,
    personaPrompt: form.personaPrompt.trim() || null,
    reactiveCron: cronFor(form.reactiveEnabled, form.reactiveCron),
    reactiveEnabled: form.reactiveEnabled,
    slackChannelId: form.slackChannelId.trim(),
    slackTeamId: form.slackTeamId.trim(),
    teamId: form.teamId,
  };
}

/** Call only after `validateChannelForm` returned no errors. */
export function formToUpdateBody(form: ChannelFormState): UpdateSlackChannelBody {
  return {
    agentKey: form.agentKey || undefined,
    ambientCron: cronFor(form.ambientEnabled, form.ambientCron),
    ambientEnabled: form.ambientEnabled,
    consolidationEnabled: form.consolidationEnabled,
    followupSessionEnabled: form.followupSessionEnabled,
    isPrivate: form.isPrivate,
    monthlyBudgetUsdCents: dollarsToCents(form.budgetDollars) ?? null,
    name: form.name.trim() || null,
    openItemNudgeAfterHours: parseOptionalPositiveInt(form.openItemNudgeAfterHours) ?? null,
    openItemNudgeCooldownHours: parseOptionalPositiveInt(form.openItemNudgeCooldownHours) ?? null,
    orgFlagCooldownHours: parseOptionalPositiveInt(form.orgFlagCooldownHours) ?? null,
    orgFlaggingEnabled: form.orgFlaggingEnabled,
    passiveIngestEnabled: form.passiveIngestEnabled,
    personaPrompt: form.personaPrompt.trim() || null,
    reactiveCooldownMinutes: parseOptionalPositiveInt(form.reactiveCooldownMinutes) ?? null,
    reactiveCron: cronFor(form.reactiveEnabled, form.reactiveCron),
    reactiveEnabled: form.reactiveEnabled,
    reactiveLookbackMinutes: parseOptionalPositiveInt(form.reactiveLookbackMinutes) ?? null,
    teamId: form.teamId || undefined,
  };
}
