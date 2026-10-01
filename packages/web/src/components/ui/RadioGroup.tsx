import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
  /** A quiet line under the label, for card-style options. */
  description?: ReactNode;
}

/**
 * Native radios in a `<fieldset>`, so the group is named by its legend and the
 * arrow keys move between options. Each option is a labelled row with an
 * optional description. `hideLegend` keeps the legend for assistive tech when
 * a surrounding heading already names the group.
 */
export function RadioGroup<T extends string>({
  className,
  hideLegend = false,
  legend,
  name,
  onChange,
  options,
  value,
}: {
  className?: string;
  hideLegend?: boolean;
  legend: string;
  name: string;
  onChange: (value: T) => void;
  options: RadioOption<T>[];
  value: T;
}) {
  return (
    <fieldset className={cn('space-y-3', className)}>
      <legend className={hideLegend ? 'sr-only' : 'label-mono mb-2 block'}>{legend}</legend>
      {options.map((o) => (
        <label className="flex cursor-pointer items-start gap-3" key={o.value}>
          <input
            checked={value === o.value}
            className="mt-0.5 h-4 w-4 shrink-0 accent-ember-400"
            name={name}
            onChange={() => onChange(o.value)}
            type="radio"
            value={o.value}
          />
          <span>
            <span className="text-sm text-paper-100">{o.label}</span>
            {o.description && (
              <span className="mt-0.5 block text-xs text-paper-500">{o.description}</span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
