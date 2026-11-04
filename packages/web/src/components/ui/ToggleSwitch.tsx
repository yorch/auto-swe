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
        // `relative` + the ::after inflates the 20px track to the 24px WCAG 2.5.8 floor (44px on
        // a coarse pointer) without moving its neighbours.
        'relative flex items-center gap-2 rounded-full after:absolute after:-inset-1 pointer-coarse:after:-inset-3',
        FOCUS_RING,
        'disabled:cursor-not-allowed disabled:opacity-50',
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
          // Off: a field-border ring so the track's edge reads against the card (the fill alone is ~1.3:1).
          checked ? 'bg-accent-400' : 'bg-ink-500 ring-1 ring-ink-200 ring-inset'
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
