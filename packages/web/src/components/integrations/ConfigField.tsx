import type { ReactNode } from 'react';
import type { ConfigSource } from '@/hooks/useAdminConfig';
import { SourceBadge } from './SourceBadge';

interface ConfigFieldProps {
  /** Must match the control's `id` — this is what `htmlFor` points at. */
  id: string;
  label: string;
  source?: ConfigSource;
  /**
   * Echo of the value the backend already holds, rendered as `current: …`.
   * Pass `undefined` to omit it; `0` and `false` are values, so only
   * `undefined`, `null`, `false` and `''` hide the echo.
   */
  current?: ReactNode;
  /** Aside rendered in the label row instead of a `current:` echo. */
  note?: ReactNode;
  children: ReactNode;
}

/**
 * Label chrome for a field on the admin integrations tabs: the `label-mono`
 * caption, the db/env `SourceBadge`, and the echo of what the backend already
 * holds. The control is the child — an `Input` / `Select` / `Textarea` with
 * `compact`, no `label` of its own, and the same `id`. `SecretInput` is this
 * chrome around a masked `Input`.
 */
export function ConfigField({ id, label, source, current, note, children }: ConfigFieldProps) {
  const showCurrent =
    current !== undefined && current !== null && current !== false && current !== '';

  return (
    <div className="space-y-1.5">
      <label className="label-mono flex items-center gap-2" htmlFor={id}>
        {label}
        <SourceBadge source={source} />
        {showCurrent && (
          <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
            current: {current}
          </span>
        )}
        {note && (
          <span className="font-mono text-[10px] normal-case tracking-normal text-paper-600">
            {note}
          </span>
        )}
      </label>
      {children}
    </div>
  );
}
