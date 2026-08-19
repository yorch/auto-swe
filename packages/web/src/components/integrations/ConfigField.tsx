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
 * Label chrome for a field on the admin integrations tabs: the uppercase
 * caption, the db/env `SourceBadge`, and the echo of what the backend already
 * holds. `SecretInput` renders the same chrome for masked fields; this covers
 * every other control, which is why it takes the control as children rather
 * than owning an `<input>` — the tabs use inputs, selects and a textarea.
 */
export function ConfigField({ id, label, source, current, note, children }: ConfigFieldProps) {
  const showCurrent =
    current !== undefined && current !== null && current !== false && current !== '';

  return (
    <div>
      <label className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500" htmlFor={id}>
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
