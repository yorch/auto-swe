'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { type ConfigSource, type MaskedField, useClearConfigSecret } from '@/hooks/useAdminConfig';
import { ConfigField } from './ConfigField';

/** Which stored secret a field can clear: the integration it belongs to and its field name. */
export interface SecretTarget {
  field: string;
  integration: string;
}

interface SecretInputProps {
  id: string;
  label: string;
  current: MaskedField | null | undefined;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  source?: ConfigSource;
  /** When set, a stored value can be removed with "Clear stored value". */
  clear?: SecretTarget;
}

/**
 * Where a secret's value comes from, and the way to remove the stored one: "Stored in DB"
 * (with a clear action), "From environment", or "Not set". Clearing a stored value hands the
 * field back to its environment variable when one is set.
 */
export function SecretStatus({
  clear,
  current,
  label,
  source,
}: {
  clear?: SecretTarget;
  current: MaskedField | null | undefined;
  label: string;
  source?: ConfigSource;
}) {
  const [confirming, setConfirming] = useState(false);
  const clearSecret = useClearConfigSecret(clear?.integration ?? '');
  const stored = !!current;
  const fallsBackToEnv = source === 'env';

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-paper-400">
      <span>
        {stored
          ? `Stored in DB (ending ${current.lastFour}). Leave blank to keep it.`
          : fallsBackToEnv
            ? 'From environment. Saving a value here overrides it.'
            : 'Not set'}
      </span>
      {stored && clear && (
        <>
          <Button
            aria-label={`Clear stored value for ${label}`}
            onClick={() => setConfirming(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Clear stored value
          </Button>
          <ConfirmModal
            confirmLabel="Clear value"
            dangerous
            message={
              source === 'db'
                ? 'The stored value is removed. If the matching environment variable is set, the platform uses that instead; otherwise this setting is empty and anything that depends on it stops working.'
                : 'The stored value is removed.'
            }
            onClose={() => setConfirming(false)}
            onConfirm={async () => {
              await clearSecret.mutateAsync(clear.field);
            }}
            open={confirming}
            pendingLabel="Clearing…"
            title={`Clear ${label}?`}
          />
        </>
      )}
    </div>
  );
}

/**
 * Password input for a masked secret field.
 * When the user types, the real value is collected and sent on save.
 * If the user leaves it empty, the field is omitted from the PUT body (partial update).
 * Below the input, `SecretStatus` says whether the value is stored, inherited or unset.
 */
export function SecretInput({
  id,
  label,
  current,
  value,
  onChange,
  placeholder,
  source,
  clear,
}: SecretInputProps) {
  const setPlaceholder = current ? `••••${current.lastFour}` : (placeholder ?? 'Enter value…');

  return (
    <ConfigField id={id} label={label}>
      <Input
        autoComplete="off"
        compact
        id={id}
        onChange={(e) => onChange(e.target.value)}
        placeholder={setPlaceholder}
        type="password"
        value={value}
      />
      <SecretStatus clear={clear} current={current} label={label} source={source} />
    </ConfigField>
  );
}
