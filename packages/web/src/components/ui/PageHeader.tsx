import { cn } from '@/lib/utils';
import { DocLink } from './DocLink';

export function PageHeader({
  title,
  subtitle,
  actions,
  learnMore,
  className,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /** A link under the subtitle to the doc that explains this page. */
  learnMore?: { slug: string; anchor?: string; label?: string };
  className?: string;
}) {
  return (
    <header
      className={cn(
        'mb-8 flex flex-col gap-4 md:flex-row md:flex-wrap md:items-start md:justify-between md:gap-6',
        className
      )}
    >
      <div className="min-w-0">
        <h1 className="break-words text-2xl font-semibold leading-tight tracking-[-0.02em] text-paper-50 md:text-[28px]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-paper-400">{subtitle}</p>
        )}
        {learnMore && (
          <p className="mt-2">
            <DocLink anchor={learnMore.anchor} label={learnMore.label} slug={learnMore.slug} />
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 md:pt-1">{actions}</div>
      )}
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
        'mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-ink-600 pb-3',
        className
      )}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
        {number && (
          <span className="font-mono text-[11px] text-ember-300 tabular-nums">{number}</span>
        )}
        <h2 className="text-lg font-semibold tracking-tight text-paper-100">{title}</h2>
        {hint && <span className="text-[12.5px] text-paper-500">{hint}</span>}
      </div>
      {actions && <div className="max-w-full max-sm:w-full max-sm:overflow-x-auto">{actions}</div>}
    </div>
  );
}
