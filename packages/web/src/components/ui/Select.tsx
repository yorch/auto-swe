import type { SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { FieldWrapper, fieldDescribedBy } from './FieldWrapper';

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  hint?: string;
  error?: string;
  /** Dense rails and inline editors: `h-8`, mono `text-xs`. */
  compact?: boolean;
};

export function Select({
  label,
  hint,
  error,
  className,
  compact = false,
  id,
  required,
  children,
  ...props
}: SelectProps) {
  const selectId = id ?? props.name ?? label?.toLowerCase().replace(/\s+/g, '-');

  const describedBy = fieldDescribedBy(selectId, hint, error);

  const selectEl = (
    <select
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
      className={cn(
        'w-full border border-ink-400 bg-ink-900/60 text-paper-100 outline-none transition-colors',
        compact ? 'h-8 px-2 font-mono text-xs' : 'h-10 px-3 text-sm',
        'focus:border-ember-400 focus:bg-ink-900/80',
        error && 'border-brick-400 focus:border-brick-400',
        className
      )}
      id={selectId}
      required={required}
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
    <FieldWrapper error={error} hint={hint} id={selectId} label={label} required={required}>
      {selectEl}
    </FieldWrapper>
  );
}
