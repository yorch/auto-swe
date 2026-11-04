'use client';

import { type InputHTMLAttributes, useId } from 'react';
import { cn, FIELD_FOCUS } from '@/lib/utils';
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
  // Never derived from the label: two "Name" fields on one page would share an id and break
  // htmlFor and aria-describedby. `useId` is the last resort, so a bare field still links its hint.
  const generatedId = useId();
  const inputId = id ?? props.name ?? generatedId;
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
            'w-full rounded-md border border-ink-200 bg-ink-900 text-paper-100 transition-colors',
            FIELD_FOCUS,
            compact ? 'h-8 px-2.5 text-sm' : 'h-9 px-3 text-sm',
            'pointer-coarse:min-h-11',
            'hover:border-paper-600',
            'placeholder:text-paper-600',
            error &&
              'border-danger-400 focus-visible:border-danger-400 focus-visible:outline-danger-400',
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
