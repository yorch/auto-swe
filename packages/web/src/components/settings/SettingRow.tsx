'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { SettingScope, SettingSource, SettingView } from '@/hooks/useConfigSettings';
import { platformRoleLabel } from '@/lib/govLabels';

/**
 * One editable setting, rendered from its definition rather than hand-written.
 * The input type comes from the shape of the value, and everything that tells
 * the operator *why* the current value is what it is — the source scope, the
 * default, whether a run has it frozen — is shown alongside it.
 */

const SOURCE_LABELS: Record<SettingSource, string> = {
  CHANNEL: 'Channel override',
  DEFAULT: 'Built-in default',
  GLOBAL: 'Platform-wide',
  ORGANIZATION: 'Organization override',
  PINNED: 'Frozen by the run',
  TEAM: 'Team override',
  WORKFLOW_TEMPLATE: 'Template override',
};

/// Muted for the two "nobody set this" sources, so a scanned list makes the
/// deliberately-configured values stand out from the inherited ones.
const SOURCE_TONE: Record<SettingSource, string> = {
  CHANNEL: 'text-ember-400',
  DEFAULT: 'text-paper-500',
  GLOBAL: 'text-paper-400',
  ORGANIZATION: 'text-ember-400',
  PINNED: 'text-amber-400',
  TEAM: 'text-ember-400',
  WORKFLOW_TEMPLATE: 'text-ember-400',
};

const SCOPE_NOUN: Record<SettingScope, string> = {
  CHANNEL: 'per channel',
  GLOBAL: 'platform-wide',
  ORGANIZATION: 'per organization',
  TEAM: 'per team',
  WORKFLOW_TEMPLATE: 'per workflow template',
};

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
}

/// A list setting is edited as comma-separated text; blanks are dropped so a
/// trailing comma does not save an empty entry the schema would reject.
function parseList(draft: string): string[] {
  return draft
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** What happened to this one row's last save or removal. */
export type SettingRowStatus =
  | { phase: 'saving' }
  | { phase: 'saved' }
  | { phase: 'error'; message: string };

export function SettingRow({
  setting,
  scope,
  scopeKey,
  canWriteHere,
  onSave,
  onClear,
  onEdit,
  status,
  sourceHref,
  grantsHref,
}: {
  setting: SettingView;
  /// The scope currently being viewed, used only to word the disabled reason.
  scope: SettingScope;
  /// Identity of the whole selection being viewed (scope plus team), which
  /// `scope` alone cannot give: two teams are the same `TEAM`. A change drops
  /// the draft even when the inherited value is equal across the two views,
  /// so Save can never write an override the operator did not mean at the
  /// new scope.
  scopeKey: string;
  /// The server's verdict on whether this actor may write this key at this
  /// scope — role floor, allowed scopes and grants together. The row stays
  /// visible when false, because seeing the inherited value is the point of
  /// scoping the view; only the controls are disabled.
  canWriteHere: boolean;
  onSave: (value: unknown) => void;
  onClear: () => void;
  /// Called when the person starts editing, so a stale saved/error line clears.
  onEdit: () => void;
  status?: SettingRowStatus;
  /// Where the value shown was set, when that is a view the page can open.
  sourceHref?: string;
  /// Set for someone who may open Config grants; the "needs a role" line then links there.
  grantsHref?: string;
}) {
  const busy = status?.phase === 'saving';
  const [draft, setDraft] = useState<string>(() => formatValue(setting.value));
  const [boolDraft, setBoolDraft] = useState<boolean>(() => setting.value === true);

  // Re-seed from the server whenever the resolved value changes (after a save)
  // or the viewed scope does, so the field never shows a stale edit. The scope
  // is a dependency of its own because the value can be identical in both views.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scopeKey` is a reset trigger, not a value read in the body
  useEffect(() => {
    setDraft(formatValue(setting.value));
    setBoolDraft(setting.value === true);
  }, [setting.value, scopeKey]);

  const isBoolean = typeof setting.defaultValue === 'boolean';
  const isNumber = typeof setting.defaultValue === 'number';
  const isList = Array.isArray(setting.defaultValue);
  const hasOverrideHere = setting.overrideAtScope !== undefined;

  const parsedDraft = isBoolean
    ? boolDraft
    : isNumber
      ? Number(draft)
      : isList
        ? parseList(draft)
        : draft;
  const invalidNumber = isNumber && !Number.isFinite(Number(draft));
  const dirty = isBoolean ? boolDraft !== setting.value : formatValue(setting.value) !== draft;

  return (
    <div className="border-t border-ink-600 py-4 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-paper-100">{setting.label}</span>
            <code className="font-mono text-[10px] text-paper-500">{setting.key}</code>
            {setting.restartRequired && (
              <Badge tone="amber" uppercase variant="text">
                restart required
              </Badge>
            )}
            {setting.runPinned && (
              <Badge tone="neutral" uppercase variant="text">
                frozen per run
              </Badge>
            )}
          </div>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-paper-400">
            {setting.description}
          </p>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wider">
            {sourceHref ? (
              <Link
                className={`${SOURCE_TONE[setting.source]} underline-offset-2 hover:underline`}
                href={sourceHref}
              >
                {SOURCE_LABELS[setting.source]}
              </Link>
            ) : (
              <span className={SOURCE_TONE[setting.source]}>{SOURCE_LABELS[setting.source]}</span>
            )}
            <span className="text-paper-600"> · default {formatValue(setting.defaultValue)}</span>
            <span className="text-paper-600">
              {' '}
              · needs {platformRoleLabel(setting.requiredRole).toLowerCase()}
            </span>
          </p>
        </div>

        <div className="flex w-64 shrink-0 flex-col gap-2">
          {isBoolean ? (
            <ToggleSwitch
              checked={boolDraft}
              disabled={!canWriteHere || busy || setting.redacted}
              // The visually hidden prefix gives the switch the setting's name
              // instead of just its state.
              label={
                <>
                  <span className="sr-only">{setting.label}: </span>
                  {boolDraft ? 'Enabled' : 'Disabled'}
                </>
              }
              onChange={() => {
                onEdit();
                setBoolDraft((current) => !current);
              }}
            />
          ) : (
            <Input
              aria-label={setting.label}
              disabled={!canWriteHere || busy || setting.redacted}
              error={invalidNumber ? 'Must be a number' : undefined}
              hint={setting.unit ?? (isList ? 'comma-separated' : undefined)}
              id={`setting-${setting.key}`}
              inputMode={isNumber ? 'numeric' : undefined}
              onChange={(e) => {
                onEdit();
                setDraft(e.target.value);
              }}
              // Withheld by the server for anyone below the setting's role.
              placeholder={
                setting.redacted
                  ? `Hidden — ${platformRoleLabel(setting.requiredRole).toLowerCase()} only`
                  : undefined
              }
              value={setting.redacted ? '' : draft}
            />
          )}
          <div className="flex gap-2">
            <Button
              disabled={!canWriteHere || busy || !dirty || invalidNumber}
              onClick={() => onSave(parsedDraft)}
              size="sm"
            >
              {status?.phase === 'saving' ? 'Saving…' : 'Save'}
            </Button>
            <Button
              disabled={!canWriteHere || busy || !hasOverrideHere}
              onClick={onClear}
              size="sm"
              variant="ghost"
            >
              Remove override
            </Button>
          </div>
          {status?.phase === 'saved' && !dirty && (
            <p className="text-xs text-moss-400" role="status">
              ✓ Saved
            </p>
          )}
          {status?.phase === 'error' && (
            <p className="text-xs text-brick-400" role="alert">
              {status.message}
            </p>
          )}
          {!canWriteHere && (
            <p className="text-xs text-paper-500">
              {!setting.overridableAt.includes(scope) && scope !== 'GLOBAL' ? (
                setting.overridableAt.length ? (
                  `Can only be set ${['platform-wide', ...setting.overridableAt.map((o) => SCOPE_NOUN[o])].join(', ')}.`
                ) : (
                  'Can only be set platform-wide.'
                )
              ) : (
                <>
                  Changing this needs the {platformRoleLabel(setting.requiredRole).toLowerCase()}{' '}
                  role.
                  {grantsHref && (
                    <>
                      {' '}
                      <Link className="text-ember-400 hover:underline" href={grantsHref}>
                        Delegate it with a config grant
                      </Link>
                      .
                    </>
                  )}
                </>
              )}
            </p>
          )}
          {canWriteHere && hasOverrideHere && setting.source !== 'DEFAULT' && (
            <p className="text-xs text-paper-500">Override set here</p>
          )}
        </div>
      </div>
    </div>
  );
}
