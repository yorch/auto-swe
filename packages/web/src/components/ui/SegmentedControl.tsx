import type { ReactNode } from 'react';
import { cn, FOCUS_RING } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

/**
 * A small set of mutually exclusive choices shown side by side — a time
 * range, a view mode, a playback speed. Use `TabBar` instead when the choice
 * swaps the page's content section. Each option is a toggle button carrying
 * `aria-pressed`, so the selection is announced rather than conveyed by colour
 * alone; `ariaLabel` names the group (a `<fieldset>`).
 */
export function SegmentedControl<T extends string>({
  ariaLabel,
  className,
  onChange,
  optionClassName,
  options,
  value,
}: {
  ariaLabel: string;
  className?: string;
  onChange: (value: T) => void;
  /** Extra classes for every option button, e.g. a taller touch target. */
  optionClassName?: string;
  options: SegmentedOption<T>[];
  value: T;
}) {
  return (
    <fieldset
      aria-label={ariaLabel}
      className={cn(
        'inline-flex min-w-0 max-w-full overflow-x-auto items-center gap-0.5 rounded-md border border-ink-400 bg-ink-900/60 p-0.5',
        className
      )}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            aria-pressed={selected}
            className={cn(
              'whitespace-nowrap rounded-sm px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors',
              FOCUS_RING,
              selected
                ? 'bg-ember-400/15 text-ember-400'
                : 'text-paper-500 hover:bg-ink-600/50 hover:text-paper-200',
              optionClassName
            )}
            key={opt.value}
            onClick={() => onChange(opt.value)}
            title={opt.title}
            type="button"
          >
            {opt.label}
          </button>
        );
      })}
    </fieldset>
  );
}
