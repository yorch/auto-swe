import { cn } from '@/lib/utils';

export function PageHeader({
  chapter,
  title,
  subtitle,
  actions,
  className,
}: {
  chapter?: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('mb-10 flex items-end justify-between gap-6', className)}>
      <div className="min-w-0">
        {chapter && (
          <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.24em] text-paper-500">
            {chapter}
          </div>
        )}
        <h1 className="font-display text-[44px] font-light leading-[1.05] tracking-tight text-paper-50">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-paper-400">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function SectionHeader({
  number,
  title,
  hint,
  actions,
  className,
}: {
  number?: string;
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mb-5 flex items-end justify-between gap-4 border-b border-ink-600 pb-3',
        className
      )}
    >
      <div className="flex items-baseline gap-3">
        {number && (
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ember-400">
            {number}
          </span>
        )}
        <h2 className="font-display text-xl font-medium tracking-tight text-paper-100">{title}</h2>
        {hint && (
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
            {hint}
          </span>
        )}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}
