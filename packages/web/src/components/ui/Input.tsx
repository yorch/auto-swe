import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { FieldWrapper, fieldDescribedBy } from './FieldWrapper';

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
  /** Dense rails and inline editors: `h-8`, mono `text-xs`. */
  compact?: boolean;
};

export function Input({
  label,
  hint,
  error,
  className,
  compact = false,
  id,
  ...props
}: InputProps) {
  const inputId = id ?? props.name ?? label?.toLowerCase().replace(/\s+/g, '-');
  return (
    <FieldWrapper error={error} hint={hint} id={inputId} label={label}>
      <input
        aria-describedby={fieldDescribedBy(inputId, hint, error)}
        aria-invalid={error ? true : undefined}
        className={cn(
          'w-full rounded-[9px] border border-ink-400 bg-ink-900/60 text-paper-100 outline-none transition-colors',
          compact ? 'h-8 px-2 font-mono text-xs' : 'h-10 px-3 text-sm',
          'focus:border-ember-400 focus:bg-ink-900/80',
          'placeholder:text-paper-600',
          error && 'border-brick-400 focus:border-brick-400',
          className
        )}
        id={inputId}
        {...props}
      />
    </FieldWrapper>
  );
}
