import type { ReactNode } from 'react';
import type { ConfigSource } from '@/hooks/useAdminConfig';
import { SourceBadge } from './SourceBadge';

interface ConfigFieldProps {
  /** Must match the control's `id` — this is what `htmlFor` points at. */
  id: string;
  label: string;
  source?: ConfigSource;
  /**
   * Echo of the value the backend already holds, rendered as `Current: …`.
   * Pass `undefined` to omit it; `0` and `false` are values, so only
   * `undefined`, `null`, `false` and `''` hide the echo.
   */
  current?: ReactNode;
  /** Aside rendered in the label row instead of a `Current:` echo. */
  note?: ReactNode;
  /** Help text under the control. */
  hint?: ReactNode;
  children: ReactNode;
}

/**
 * Label chrome for a field on the admin integrations tabs: the field label, the
 * db/env `SourceBadge`, and the echo of what the backend already holds. The
 * control is the child — an `Input` / `Select` / `Textarea` with `compact`, no
 * `label` of its own, and the same `id`. `SecretInput` is this chrome around a
 * masked `Input`.
 */
export function ConfigField({
  id,
  label,
  source,
  current,
  note,
  hint,
  children,
}: ConfigFieldProps) {
  const showCurrent =
    current !== undefined && current !== null && current !== false && current !== '';

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <label className="text-[13px] font-medium text-paper-200" htmlFor={id}>
          {label}
        </label>
        <SourceBadge source={source} />
        {showCurrent && (
          <span className="ml-auto max-w-full truncate text-xs text-paper-500">
            Current: <span className="font-mono text-paper-400">{current}</span>
          </span>
        )}
        {note && <span className="ml-auto text-xs text-paper-500">{note}</span>}
      </div>
      {children}
      {hint && <p className="text-xs leading-relaxed text-paper-500">{hint}</p>}
    </div>
  );
}
