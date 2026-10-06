import type { TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { FieldWrapper, fieldDescribedBy } from './FieldWrapper';

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  hint?: string;
  error?: string;
  /** Drops the 9rem minimum so `rows` sets the height, with tighter padding. */
  compact?: boolean;
};

export function Textarea({
  label,
  hint,
  error,
  className,
  compact = false,
  id,
  required,
  ...props
}: TextareaProps) {
  const inputId = id ?? props.name ?? label?.toLowerCase().replace(/\s+/g, '-');
  return (
    <FieldWrapper error={error} hint={hint} id={inputId} label={label} required={required}>
      <textarea
        aria-describedby={fieldDescribedBy(inputId, hint, error)}
        aria-invalid={error ? true : undefined}
        className={cn(
          'w-full rounded-md border border-ink-400 bg-ink-900/60 font-mono text-[12.5px] leading-relaxed text-paper-100 outline-none transition-colors',
          compact ? 'px-2 py-1.5' : 'min-h-[9rem] px-3 py-2',
          'hover:border-ink-300 focus:border-ember-400 focus:bg-ink-900/80 focus:ring-2 focus:ring-ember-400/20',
          'placeholder:text-paper-600',
          error && 'border-brick-400 focus:border-brick-400',
          className
        )}
        id={inputId}
        required={required}
        {...props}
      />
    </FieldWrapper>
  );
}
