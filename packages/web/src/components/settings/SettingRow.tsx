'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { SettingScope, SettingSource, SettingView } from '@/hooks/useConfigSettings';

/**
 * One editable setting, rendered from its definition rather than hand-written.
 * The input type comes from the shape of the value, and everything that tells
 * the operator *why* the current value is what it is — the source scope, the
 * default, whether a run has it frozen — is shown alongside it.
 */

const SOURCE_LABELS: Record<SettingSource, string> = {
  CHANNEL: 'Channel override',
  DEFAULT: 'Built-in default',
  ENV: 'Environment variable',
  GLOBAL: 'Platform-wide',
  ORGANIZATION: 'Organisation override',
  PINNED: 'Frozen by the run',
  TEAM: 'Team override',
  WORKFLOW_TEMPLATE: 'Template override',
};

/// Muted for the two "nobody set this" sources, so a scanned list makes the
/// deliberately-configured values stand out from the inherited ones.
const SOURCE_TONE: Record<SettingSource, string> = {
  CHANNEL: 'text-ember-400',
  DEFAULT: 'text-paper-500',
  ENV: 'text-amber-400',
  GLOBAL: 'text-paper-400',
  ORGANIZATION: 'text-ember-400',
  PINNED: 'text-amber-400',
  TEAM: 'text-ember-400',
  WORKFLOW_TEMPLATE: 'text-ember-400',
};

function formatValue(value: unknown): string {
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
}

export function SettingRow({
  setting,
  scope,
  canWriteHere,
  onSave,
  onClear,
  busy,
}: {
  setting: SettingView;
  /// The scope currently being viewed, used only to word the disabled reason.
  scope: SettingScope;
  /// The server's verdict on whether this actor may write this key at this
  /// scope — role floor, allowed scopes and grants together. The row stays
  /// visible when false, because seeing the inherited value is the point of
  /// scoping the view; only the controls are disabled.
  canWriteHere: boolean;
  onSave: (value: unknown) => void;
  onClear: () => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<string>(() => formatValue(setting.value));
  const [boolDraft, setBoolDraft] = useState<boolean>(() => setting.value === true);

  // Re-seed from the server whenever the resolved value changes — after a save,
  // or after switching scope — so the field never shows a stale edit.
  useEffect(() => {
    setDraft(formatValue(setting.value));
    setBoolDraft(setting.value === true);
  }, [setting.value]);

  const isBoolean = typeof setting.defaultValue === 'boolean';
  const isNumber = typeof setting.defaultValue === 'number';
  const hasOverrideHere = setting.overrideAtScope !== undefined;

  const parsedDraft = isBoolean ? boolDraft : isNumber ? Number(draft) : draft;
  const invalidNumber = isNumber && !Number.isFinite(Number(draft));
  const dirty = isBoolean ? boolDraft !== setting.value : formatValue(setting.value) !== draft;

  return (
    <div className="border-t border-ink-400/40 py-4 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-paper-100">{setting.label}</span>
            <code className="font-mono text-[10px] text-paper-500">{setting.key}</code>
            {setting.restartRequired && (
              <span className="font-mono text-[10px] uppercase tracking-wider text-amber-400">
                restart required
              </span>
            )}
            {setting.runPinned && (
              <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
                frozen per run
              </span>
            )}
          </div>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-paper-400">
            {setting.description}
          </p>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wider">
            <span className={SOURCE_TONE[setting.source]}>{SOURCE_LABELS[setting.source]}</span>
            <span className="text-paper-600"> · default {formatValue(setting.defaultValue)}</span>
            <span className="text-paper-600"> · needs {setting.requiredRole}</span>
          </p>
        </div>

        <div className="flex w-64 shrink-0 flex-col gap-2">
          {isBoolean ? (
            <ToggleSwitch
              checked={boolDraft}
              disabled={!canWriteHere || busy}
              label={boolDraft ? 'Enabled' : 'Disabled'}
              onChange={() => setBoolDraft((current) => !current)}
            />
          ) : (
            <Input
              disabled={!canWriteHere || busy}
              error={invalidNumber ? 'Must be a number' : undefined}
              hint={setting.unit}
              inputMode={isNumber ? 'numeric' : undefined}
              onChange={(e) => setDraft(e.target.value)}
              value={draft}
            />
          )}
          <div className="flex gap-2">
            <Button
              disabled={!canWriteHere || busy || !dirty || invalidNumber}
              onClick={() => onSave(parsedDraft)}
              size="sm"
            >
              Save
            </Button>
            <Button
              disabled={!canWriteHere || busy || !hasOverrideHere}
              onClick={onClear}
              size="sm"
              variant="ghost"
            >
              Reset
            </Button>
          </div>
          {!canWriteHere && (
            <p className="font-mono text-[10px] uppercase tracking-wider text-paper-600">
              {!setting.overridableAt.includes(scope) && scope !== 'GLOBAL'
                ? setting.overridableAt.length
                  ? `Set at ${['GLOBAL', ...setting.overridableAt].join(', ')}`
                  : 'Platform-wide only'
                : `Requires ${setting.requiredRole}`}
            </p>
          )}
          {canWriteHere && hasOverrideHere && setting.source !== 'DEFAULT' && (
            <p className="font-mono text-[10px] uppercase tracking-wider text-paper-600">
              Override set here
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
