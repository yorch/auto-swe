import type { SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { FieldWrapper } from './FieldWrapper';

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export function Select({ label, hint, error, className, id, children, ...props }: SelectProps) {
  const selectId = id ?? props.name ?? label?.toLowerCase().replace(/\s+/g, '-');

  const describedBy =
    [
      hint && !error && selectId ? `${selectId}-hint` : null,
      error && selectId ? `${selectId}-error` : null,
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  const selectEl = (
    <select
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
      className={cn(
        'h-10 w-full border border-ink-400 bg-ink-900/60 px-3 text-sm text-paper-100 outline-none transition-colors',
        'focus:border-ember-400 focus:bg-ink-900/80',
        error && 'border-brick-400 focus:border-brick-400',
        className
      )}
      id={selectId}
      style={{ borderRadius: 9 }}
      {...props}
    >
      {children}
    </select>
  );

  if (!label && !hint && !error) {
    return selectEl;
  }

  return (
    <FieldWrapper error={error} hint={hint} id={selectId} label={label}>
      {selectEl}
    </FieldWrapper>
  );
}
