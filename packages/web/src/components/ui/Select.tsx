import { cn } from '@/lib/utils';

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export function Select({ label, hint, error, className, id, children, ...props }: SelectProps) {
  const selectId = id ?? (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

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
    <div className="space-y-1.5">
      {label && (
        <label
          className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
          htmlFor={selectId}
        >
          {label}
        </label>
      )}
      {selectEl}
      {hint && !error && (
        <p className="font-mono text-[10px] uppercase tracking-wider text-paper-500">{hint}</p>
      )}
      {error && (
        <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">{error}</p>
      )}
    </div>
  );
}
