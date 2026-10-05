'use client';

import { cn, FOCUS_RING } from '@/lib/utils';

/**
 * A switch must have an accessible name: either a visible `label` or an
 * `ariaLabel` (for a switch in a table row or card header with no adjacent
 * text). The union makes leaving both out a type error.
 */
type ToggleSwitchName =
  | { label: React.ReactNode; ariaLabel?: string }
  | { label?: undefined; ariaLabel: string };

export function ToggleSwitch({
  ariaLabel,
  checked,
  onChange,
  disabled,
  title,
  label,
  className,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
} & ToggleSwitchName) {
  return (
    <button
      aria-checked={checked}
      aria-label={ariaLabel}
      className={cn(
        'flex items-center gap-2 rounded-full',
        FOCUS_RING,
        label && 'cursor-pointer',
        className
      )}
      disabled={disabled}
      onClick={onChange}
      role="switch"
      title={title ?? (checked ? 'Disable' : 'Enable')}
      type="button"
    >
      <span
        className={cn(
          'inline-block h-5 w-10 shrink-0 rounded-full transition-colors',
          checked ? 'bg-ember-400' : 'bg-ink-500'
        )}
      >
        <span
          className={cn(
            'block h-4 w-4 translate-x-0.5 rounded-full bg-paper-100 transition-transform',
            checked && 'translate-x-[1.375rem]'
          )}
        />
      </span>
      {label && <span className="text-sm text-paper-400">{label}</span>}
    </button>
  );
}
