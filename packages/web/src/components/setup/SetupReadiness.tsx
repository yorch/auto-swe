'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { useHasRole } from '@/hooks/useHasRole';
import { type ReadinessItemId, useReadiness } from '@/hooks/useReadiness';

/**
 * Home card for admins: lists what is still missing before work can run, each with the page
 * that fixes it. Shows a placeholder while loading and renders nothing on error or once everything is in place.
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
        className="h-64 animate-pulse rounded-xl border border-ink-400/40 bg-ink-800/50"
        data-testid="setup-readiness-loading"
      />
    );
  }
  if (!data || data.ready) {
    return null;
  }
  const missing = data.items.filter((i) => !i.ok);
  return (
    <Card className="border-amber-400/40" data-testid="setup-readiness">
      <h2 className="text-lg font-semibold">Finish setting up</h2>
      <p className="mt-1 text-sm text-paper-400">
        {missing.length === 1 ? 'One thing is' : `${missing.length} things are`} missing before runs
        can succeed.
      </p>
      <ul className="mt-4 space-y-3">
        {missing.map((item) => (
          <li className="flex flex-wrap items-start justify-between gap-2" key={item.id}>
            <div className="min-w-0">
              <div className="text-sm font-medium">{item.label}</div>
              <div className="text-xs text-paper-400">{item.detail}</div>
            </div>
            <Link className="shrink-0 text-sm text-ember-400 hover:underline" href={item.href}>
              Fix this →
            </Link>
          </li>
        ))}
      </ul>
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
  return (
    <Alert title="Setup incomplete" variant="warning">
      <ul className="space-y-1">
        {missing.map((item) => (
          <li key={item.id}>
            {item.detail}{' '}
            {item.href !== here ? (
              <Link className="text-ember-400 hover:underline" href={item.href}>
                Fix this →
              </Link>
            ) : (
              inPage && (
                <button
                  className="text-ember-400 hover:underline"
                  onClick={inPage.onClick}
                  type="button"
                >
                  {inPage.label} →
                </button>
              )
            )}
          </li>
        ))}
      </ul>
    </Alert>
  );
}
