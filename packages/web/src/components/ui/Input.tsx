import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { FieldWrapper, fieldDescribedBy } from './FieldWrapper';

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
  /** Dense rails and inline editors: `h-8`, `13px` text. */
  compact?: boolean;
  /** A fixed unit shown inside the left edge of the field, such as `$`. Decorative: the label names the unit. */
  prefix?: string;
};

export function Input({
  label,
  hint,
  error,
  className,
  compact = false,
  prefix,
  id,
  required,
  ...props
}: InputProps) {
  const inputId = id ?? props.name ?? label?.toLowerCase().replace(/\s+/g, '-');
  return (
    <FieldWrapper error={error} hint={hint} id={inputId} label={label} required={required}>
      <div className="relative">
        {prefix && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-paper-500"
          >
            {prefix}
          </span>
        )}
        <input
          aria-describedby={fieldDescribedBy(inputId, hint, error)}
          aria-invalid={error ? true : undefined}
          className={cn(
            'w-full rounded-md border border-ink-400 bg-ink-900/60 text-paper-100 outline-none transition-colors',
            compact ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3 text-sm',
            'hover:border-ink-300 focus:border-ember-400 focus:bg-ink-900/80 focus:ring-2 focus:ring-ember-400/20',
            'placeholder:text-paper-600',
            error && 'border-brick-400 focus:border-brick-400',
            prefix && 'pl-7',
            className
          )}
          id={inputId}
          required={required}
          {...props}
        />
      </div>
    </FieldWrapper>
  );
}
