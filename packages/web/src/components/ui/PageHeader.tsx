import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'mb-10 flex flex-col gap-4 md:flex-row md:flex-wrap md:items-end md:justify-between md:gap-6',
        className
      )}
    >
      <div className="min-w-0">
        <h1 className="break-words text-[26px] font-bold leading-tight tracking-tight text-paper-50 md:text-[32px]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-paper-400">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
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
        'mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-ink-600 pb-3',
        className
      )}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
        {number && (
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ember-400">
            {number}
          </span>
        )}
        <h2 className="text-lg font-semibold tracking-tight text-paper-100">{title}</h2>
        {hint && (
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-paper-400">
            {hint}
          </span>
        )}
      </div>
      {actions && <div className="max-w-full overflow-x-auto max-sm:w-full">{actions}</div>}
    </div>
  );
}
