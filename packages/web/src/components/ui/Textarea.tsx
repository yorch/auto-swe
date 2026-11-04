'use client';

import { type TextareaHTMLAttributes, useId } from 'react';
import { cn, FIELD_FOCUS } from '@/lib/utils';
import { FieldWrapper, fieldDescribedBy } from './FieldWrapper';

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  hint?: string;
  error?: string;
  /** Drops the 9rem minimum so `rows` sets the height, with tighter padding. */
  compact?: boolean;
  /** Code face (default, for backward compatibility). Pass `false` for prose such as descriptions. */
  mono?: boolean;
};

export function Textarea({
  label,
  hint,
  error,
  className,
  compact = false,
  mono = true,
  id,
  required,
  ...props
}: TextareaProps) {
  // Never derived from the label: two "Name" fields on one page would share an id and break
  // htmlFor and aria-describedby. `useId` is the last resort, so a bare field still links its hint.
  const generatedId = useId();
  const inputId = id ?? props.name ?? generatedId;
  return (
    <FieldWrapper error={error} hint={hint} id={inputId} label={label} required={required}>
      <textarea
        aria-describedby={fieldDescribedBy(inputId, hint, error)}
        aria-invalid={error ? true : undefined}
        className={cn(
          'w-full rounded-md border border-ink-200 bg-ink-900 text-sm leading-relaxed text-paper-100 transition-colors',
          FIELD_FOCUS,
          mono && 'font-mono',
          compact ? 'px-2 py-1.5' : 'min-h-[9rem] px-3 py-2',
          'hover:border-paper-600',
          'placeholder:text-paper-600',
          error &&
            'border-danger-400 focus-visible:border-danger-400 focus-visible:outline-danger-400',
          className
        )}
        id={inputId}
        required={required}
        {...props}
      />
    </FieldWrapper>
  );
}
