import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { FieldWrapper } from './FieldWrapper';

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export function Input({ label, hint, error, className, id, ...props }: InputProps) {
  const inputId = id ?? props.name ?? label?.toLowerCase().replace(/\s+/g, '-');
  return (
    <FieldWrapper error={error} hint={hint} id={inputId} label={label}>
      <input
        className={cn(
          'h-10 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 text-sm text-paper-100 outline-none transition-colors',
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
