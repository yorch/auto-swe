import { cn } from '@/lib/utils';
import { FieldWrapper } from './FieldWrapper';

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export function Select({ label, hint, error, className, id, children, ...props }: SelectProps) {
  const selectId = id ?? props.name ?? label?.toLowerCase().replace(/\s+/g, '-');

  const selectEl = (
    <select
      className={cn(
        'h-10 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 text-sm text-paper-100 outline-none transition-colors',
        'focus:border-ember-400 focus:bg-ink-900/80',
        error && 'border-brick-400 focus:border-brick-400',
        className
      )}
      id={selectId}
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
