'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Select, type SelectOption } from '@/components/ui/Select';
import { errMsg } from '@/lib/errors';

/** What to ask before a role change applies; return null for a change that needs no second look. */
export interface RoleChangeConfirmation {
  confirmLabel?: string;
  dangerous?: boolean;
  message: ReactNode;
  title: string;
}

/**
 * An inline role editor for a table row. It owns the row-local state a bare
 * `Select` lacks: the select is disabled while the change is saving, a brief
 * "Saved" confirmation follows, a failure appears under the control (not in an
 * alert far above the table), and a change that `confirm` flags opens a dialog
 * first. The select keeps showing the stored `value` until a refetch changes it.
 */
export function RoleSelectCell({
  apply,
  ariaLabel,
  className = 'w-32',
  confirm,
  disabled,
  disabledReason,
  options,
  value,
}: {
  /** Performs the change; a rejection is shown under the control. */
  apply: (to: string) => Promise<unknown>;
  ariaLabel: string;
  className?: string;
  confirm?: (from: string, to: string) => RoleChangeConfirmation | null;
  disabled?: boolean;
  /** Why the control is disabled, shown as visible text under it. */
  disabledReason?: string;
  options: SelectOption[];
  value: string;
}) {
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ confirmation: RoleChangeConfirmation; to: string } | null>(
    null
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  const run = async (to: string, inDialog = false) => {
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apply(to);
      setSaved(true);
      timer.current = setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      // The dialog shows the failure while it is open; the row shows it otherwise.
      if (!inDialog) {
        setError(errMsg(err, 'Could not change the role'));
      }
      throw err;
    } finally {
      setPending(false);
    }
  };

  const handleChange = (to: string) => {
    if (to === value) {
      return;
    }
    const confirmation = confirm?.(value, to) ?? null;
    if (confirmation) {
      setAsking({ confirmation, to });
      return;
    }
    void run(to).catch(() => undefined);
  };

  return (
    <div className="min-w-0">
      <Select
        aria-label={ariaLabel}
        className={className}
        compact
        disabled={disabled || pending}
        onChange={handleChange}
        options={options}
        value={value}
      />
      <div aria-live="polite" className="min-h-0 text-xs">
        {pending && <span className="text-paper-500">Saving…</span>}
        {saved && !pending && <span className="text-success-400">Saved</span>}
        {error && (
          <span className="text-danger-400" role="alert">
            {error}
          </span>
        )}
        {disabled && disabledReason && <span className="text-paper-500">{disabledReason}</span>}
      </div>
      <ConfirmModal
        confirmLabel={asking?.confirmation.confirmLabel ?? 'Change role'}
        dangerous={asking?.confirmation.dangerous}
        message={asking?.confirmation.message ?? ''}
        onClose={() => setAsking(null)}
        onConfirm={async () => {
          if (asking) {
            await run(asking.to, true);
          }
        }}
        open={asking !== null}
        title={asking?.confirmation.title ?? 'Change role?'}
      />
    </div>
  );
}
