'use client';

import Link from 'next/link';
import { OnboardingCard } from '@/components/setup/OnboardingCard';
import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useHasRole } from '@/hooks/useHasRole';
import { type ReadinessItemId, useReadiness } from '@/hooks/useReadiness';
import { readinessSummary } from '@/lib/readinessSummary';
import { cn, FOCUS_RING } from '@/lib/utils';

/**
 * Home checklist for admins: every step a first run needs, with what is done ticked off and
 * each missing step linking to the page that fixes it. Renders nothing while loading, on error
 * and once everything is in place without informational notes. A fully set-up admin never sees
 * a placeholder flash and collapse.
 */
export function SetupReadiness({
  embedded = false,
  onNavigate,
}: {
  embedded?: boolean;
  onNavigate?: () => void;
}) {
  const isAdmin = useHasRole('ADMIN');
  const { data, isLoading } = useReadiness(isAdmin);
  if (!isAdmin) {
    return null;
  }
  if (isLoading || !data || (data.ready && !data.items.some((item) => item.informational))) {
    return null;
  }
  const done = data.items.filter((i) => i.ok).length;
  const total = data.items.length;
  const missing = total - done;
  const percent = total ? Math.round((done / total) * 100) : 0;
  // The first unfinished step is the one to do next; it gets the primary button.
  const nextId = data.items.find((i) => !i.ok)?.id;
  return (
    <OnboardingCard
      className={embedded ? 'border-0 bg-transparent p-0 sm:p-0' : 'border-warning-400/30'}
      status={
        <span className="tabular text-sm text-paper-300">
          {done} of {total} done
        </span>
      }
      subtitle={
        data.ready
          ? 'Setup is complete. Review the informational notes below.'
          : `${missing === 1 ? 'One step is' : `${missing} steps are`} left before runs can succeed.`
      }
      testId="setup-readiness"
      title={data.ready ? 'Setup status' : 'Finish setting up'}
    >
      <div
        aria-label="Setup progress"
        aria-valuemax={total}
        aria-valuemin={0}
        aria-valuenow={done}
        aria-valuetext={`${done} of ${total} steps done`}
        className="mt-4 h-1.5 overflow-hidden rounded-full bg-ink-600"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-accent-500 transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
      <ol className="mt-5 divide-y divide-ink-600 overflow-hidden rounded-lg border border-ink-500/60">
        {data.items.map((item, index) => (
          <li
            className={cn(
              'flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3',
              !item.ok && 'bg-ink-800/40'
            )}
            key={item.id}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs tabular',
                item.ok
                  ? 'border-success-400/40 bg-success-400/15 text-success-400'
                  : 'border-ink-400 text-paper-400'
              )}
            >
              {item.ok ? <Icon name="check" size={13} strokeWidth={2.4} /> : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div
                className={cn('text-sm font-medium', item.ok ? 'text-paper-400' : 'text-paper-100')}
              >
                {item.label}
                <span className="sr-only">{item.ok ? ' (done)' : ' (to do)'}</span>
              </div>
              {(!item.ok || item.informational) && (
                <div className="mt-0.5 text-xs text-paper-400">
                  {readinessSummary(item, data).map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  {item.id === 'credentials' && !item.ok && (
                    <details className="mt-1">
                      <summary
                        className={cn(
                          'w-fit cursor-pointer rounded-sm hover:text-paper-100',
                          FOCUS_RING
                        )}
                      >
                        View affected agents
                      </summary>
                      <p className="mt-1 break-words">{item.detail}</p>
                    </details>
                  )}
                </div>
              )}
            </div>
            {item.ok ? (
              <span className="shrink-0 text-xs text-success-400">Done</span>
            ) : (
              <ButtonLink
                className="shrink-0"
                href={item.href}
                onClick={onNavigate}
                size="sm"
                variant={item.id === nextId ? 'primary' : 'secondary'}
              >
                Fix this
                <span className="sr-only">: {item.label}</span>
                <Icon name="arrowRight" size={13} />
              </ButtonLink>
            )}
          </li>
        ))}
      </ol>
    </OnboardingCard>
  );
}

/**
 * A compact banner for a studio page, limited to the items that page can fix.
 * `inPage` replaces a link to the current tab with an action on that page.
 */
export function SetupBanner({
  items,
  here,
  inPage,
  compact = false,
}: {
  items: ReadinessItemId[];
  here?: string;
  inPage?: { label: string; onClick: () => void };
  compact?: boolean;
}) {
  const isAdmin = useHasRole('ADMIN');
  const { data } = useReadiness(isAdmin);
  const missing = data?.items.filter((i) => !i.ok && items.includes(i.id)) ?? [];
  if (!isAdmin || !data || missing.length === 0) {
    return null;
  }
  const linkClass = cn(
    'inline-flex items-center gap-1 rounded-sm font-medium text-paper-100 underline-offset-2 hover:underline focus-visible:underline',
    FOCUS_RING
  );
  const banner = (
    <ul aria-label="Setup needs attention" className="space-y-1 text-sm text-warning-400">
      {missing.flatMap((item) =>
        readinessSummary(item, data).map((line) => (
          <li key={`${item.id}:${line}`}>
            <span>{line}</span>
            {' — '}
            {item.href === here && inPage ? (
              <button className={linkClass} onClick={inPage.onClick} type="button">
                {inPage.label}
                <Icon name="arrowRight" size={12} />
              </button>
            ) : (
              <Link className={linkClass} href={item.href}>
                Fix
                <span className="sr-only">: {item.label}</span>
                <Icon name="arrowRight" size={12} />
              </Link>
            )}
          </li>
        ))
      )}
    </ul>
  );
  return compact ? (
    <details className="rounded-lg border border-warning-400/30 bg-warning-400/5 p-3">
      <summary className="cursor-pointer text-sm text-warning-400">
        Setup incomplete — {missing.length} {missing.length === 1 ? 'item needs' : 'items need'}{' '}
        attention
      </summary>
      <div className="mt-3">{banner}</div>
    </details>
  ) : (
    banner
  );
}
