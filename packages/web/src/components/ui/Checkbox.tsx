import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { RequiredMark } from './FieldWrapper';

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: ReactNode;
  hint?: ReactNode;
  /**
   * Shows the `*` marker only. Not the native `required`, which on a checkbox
   * means "must be ticked" — a boolean field's `false` is a valid answer.
   */
  marked?: boolean;
};

/**
 * Native checkbox with its label. The `<label>` wraps the input, so the pair
 * is associated without an id and the whole row is the click target. For an
 * on/off *setting* prefer `ToggleSwitch`; this is for choices inside a form
 * ("show consolidated", "overdue only", a selection list).
 */
export function Checkbox({ className, disabled, hint, label, marked, ...props }: CheckboxProps) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 text-sm text-paper-300',
        disabled && 'cursor-not-allowed opacity-50',
        className
      )}
    >
      <input
        className="mt-0.5 h-4 w-4 shrink-0 accent-ember-400"
        disabled={disabled}
        type="checkbox"
        {...props}
      />
      <span>
        {label}
        {marked && <RequiredMark />}
        {hint && <span className="mt-0.5 block text-xs text-paper-500">{hint}</span>}
      </span>
    </label>
  );
}
