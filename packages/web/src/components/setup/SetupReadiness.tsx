'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/LoadingState';
import { useHasRole } from '@/hooks/useHasRole';
import { type ReadinessItemId, useReadiness } from '@/hooks/useReadiness';
import { cn, FOCUS_RING } from '@/lib/utils';

/**
 * Home checklist for admins: every step a first run needs, with what is done ticked off and
 * each missing step linking to the page that fixes it. Shows a placeholder while loading and
 * renders nothing on error or once everything is in place.
 */
export function SetupReadiness() {
  const isAdmin = useHasRole('ADMIN');
  const { data, isLoading } = useReadiness(isAdmin);
  if (!isAdmin) {
    return null;
  }
  // Reserve the card's footprint while the check runs so Home does not jump when it lands.
  if (isLoading) {
    return (
      <div
        aria-hidden="true"
        className="space-y-4 rounded-xl border border-ink-400/40 bg-ink-800/50 p-6"
        data-testid="setup-readiness-loading"
      >
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-1.5 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (!data || data.ready) {
    return null;
  }
  const done = data.items.filter((i) => i.ok).length;
  const total = data.items.length;
  const missing = total - done;
  const percent = total ? Math.round((done / total) * 100) : 0;
  // The first unfinished step is the one to do next; it gets the primary button.
  const nextId = data.items.find((i) => !i.ok)?.id;
  return (
    <Card className="border-amber-400/30" data-testid="setup-readiness">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="kicker mb-1">Getting started</div>
          <h2 className="text-[17px] font-semibold tracking-tight text-paper-50">
            Finish setting up
          </h2>
          <p className="mt-1 text-sm text-paper-400">
            {missing === 1 ? 'One step is' : `${missing} steps are`} left before runs can succeed.
          </p>
        </div>
        <span className="tabular text-sm text-paper-300">
          {done} of {total} done
        </span>
      </div>
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
          className="h-full rounded-full bg-gradient-to-r from-ember-500 to-ember-400 transition-[width]"
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
                  ? 'border-moss-400/40 bg-moss-400/15 text-moss-400'
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
              {!item.ok && <div className="mt-0.5 text-xs text-paper-400">{item.detail}</div>}
            </div>
            {item.ok ? (
              <span className="shrink-0 text-xs text-moss-400">Done</span>
            ) : (
              <ButtonLink
                className="shrink-0"
                href={item.href}
                size="sm"
                variant={item.id === nextId ? 'primary' : 'secondary'}
              >
                Fix this
                <Icon name="arrowRight" size={13} />
              </ButtonLink>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * A compact banner for a studio page, limited to the items that page can fix.
 * `here` is the href of the page and tab the banner sits on: a "Fix this" link
 * to where the person already is does nothing, so it is replaced by `inPage`
 * (an action that works on the open page) or left out.
 */
export function SetupBanner({
  items,
  here,
  inPage,
}: {
  items: ReadinessItemId[];
  here?: string;
  inPage?: { label: string; onClick: () => void };
}) {
  const isAdmin = useHasRole('ADMIN');
  const { data } = useReadiness(isAdmin);
  const missing = data?.items.filter((i) => !i.ok && items.includes(i.id)) ?? [];
  if (!isAdmin || missing.length === 0) {
    return null;
  }
  const linkClass = cn(
    'inline-flex items-center gap-1 rounded-sm font-medium text-ember-400 hover:underline',
    FOCUS_RING
  );
  return (
    <Alert title="Setup incomplete" variant="warning">
      <ul className="space-y-1">
        {missing.map((item) => (
          <li key={item.id}>
            {item.detail}{' '}
            {item.href !== here ? (
              <Link className={linkClass} href={item.href}>
                Fix this
                <Icon name="arrowRight" size={12} />
              </Link>
            ) : (
              inPage && (
                <button className={linkClass} onClick={inPage.onClick} type="button">
                  {inPage.label}
                  <Icon name="arrowRight" size={12} />
                </button>
              )
            )}
          </li>
        ))}
      </ul>
    </Alert>
  );
}
