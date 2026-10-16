import { PageHelp } from '@/components/help/PageHelp';
import { cn } from '@/lib/utils';
import { DocLink } from './DocLink';

export function PageHeader({
  title,
  subtitle,
  actions,
  help,
  learnMore,
  className,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /**
   * Explanation that does not belong on the page itself. It shows in the Help panel (the "?" in
   * the top bar), so the subtitle can stay one short sentence.
   */
  help?: React.ReactNode;
  /** A link, in the Help panel, to the doc that explains this page. */
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
        <h1 className="break-words text-2xl font-semibold leading-tight tracking-[-0.02em] text-paper-50 md:text-3xl">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-paper-400">{subtitle}</p>
        )}
        {(help || learnMore) && (
          <PageHelp>
            {help}
            {learnMore && (
              <p>
                <DocLink anchor={learnMore.anchor} label={learnMore.label} slug={learnMore.slug} />
              </p>
            )}
          </PageHelp>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 md:pt-1">{actions}</div>
      )}
    </header>
  );
}

export function SectionHeader({
  title,
  hint,
  actions,
  className,
}: {
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
        <h2 className="text-lg font-semibold tracking-tight text-paper-100">{title}</h2>
        {hint && <span className="text-sm text-paper-500">{hint}</span>}
      </div>
      {actions && <div className="max-w-full max-sm:w-full max-sm:overflow-x-auto">{actions}</div>}
    </div>
  );
}
