import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { Icon, type IconName } from '@/components/ui/Icon';
import { cn } from '@/lib/utils';

/**
 * One block of the account settings page: a card whose header names the
 * section, says in a line what it is for, and carries the section's one action.
 * The body sits flush below a divider, so a list or table inside it lines up
 * with the card edges.
 */
export function SettingsSection({
  actions,
  children,
  className,
  description,
  icon,
  id,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  icon: IconName;
  /** Anchor for in-page links and the section's accessible name. */
  id: string;
  title: string;
}) {
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className="scroll-mt-6" id={id}>
      <Card className={cn('p-0', className)}>
        <header className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex min-w-0 items-start gap-3.5">
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-400/70 bg-ink-800/80 text-ember-300"
            >
              <Icon name={icon} size={17} />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight text-paper-50" id={headingId}>
                {title}
              </h2>
              {description && (
                <p className="mt-0.5 text-[13px] leading-relaxed text-paper-500">{description}</p>
              )}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
        <div className="border-t border-ink-600 px-5 py-2 sm:px-6">{children}</div>
      </Card>
    </section>
  );
}

/**
 * A row in a settings list: a leading mark, a name with a detail line under it,
 * an optional status, and the row's action on the right. Wraps below `sm` so the
 * action never pushes the name off-screen.
 */
export function SettingsListRow({
  action,
  detail,
  leading,
  status,
  title,
}: {
  action?: ReactNode;
  detail?: ReactNode;
  leading?: ReactNode;
  status?: ReactNode;
  title: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5">
      {leading && (
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-400/70 bg-ink-700 text-paper-200"
        >
          {leading}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-sm font-medium text-paper-100">{title}</span>
          {status}
        </div>
        {detail && (
          <div className="mt-0.5 text-[13px] leading-relaxed text-paper-500">{detail}</div>
        )}
      </div>
      {action && <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>}
    </li>
  );
}
