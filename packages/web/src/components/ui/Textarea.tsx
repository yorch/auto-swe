import type { TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { FieldWrapper, fieldDescribedBy } from './FieldWrapper';

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export function Textarea({ label, hint, error, className, id, ...props }: TextareaProps) {
  const inputId = id ?? props.name ?? label?.toLowerCase().replace(/\s+/g, '-');
  return (
    <FieldWrapper error={error} hint={hint} id={inputId} label={label}>
      <textarea
        aria-describedby={fieldDescribedBy(inputId, hint, error)}
        aria-invalid={error ? true : undefined}
        className={cn(
          'min-h-[9rem] w-full rounded-[9px] border border-ink-400 bg-ink-900/60 px-3 py-2 font-mono text-xs text-paper-100 outline-none transition-colors',
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
