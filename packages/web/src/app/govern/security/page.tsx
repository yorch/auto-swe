'use client';

import { Suspense } from 'react';
import {
  SECURITY_EVENT_META,
  SECURITY_EVENT_TYPES,
  SecurityEventBadge,
  type SecurityEventGroup,
  SecurityEventList,
  securityEventLabel,
} from '@/components/security/SecurityEventList';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { DateRangeControl } from '@/components/ui/DateRangeControl';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Stat } from '@/components/ui/Stat';
import type { SecurityEventSummary, SecurityEventType } from '@/hooks/useAdmin';
import { useSecurityEventSummary, useSecurityEvents } from '@/hooks/useAdmin';
import { useUrlParams } from '@/hooks/useUrlParams';
import { dateRangePatch, dayBounds, parseDateRange } from '@/lib/dateRange';
import { formatDelta } from '@/lib/delta';

const TYPE_OPTIONS: Array<{ label: string; value: SecurityEventType | '' }> = [
  { label: 'All types', value: '' },
  ...SECURITY_EVENT_TYPES.map((type) => ({ label: securityEventLabel(type), value: type })),
];

const LIMIT = 50;

const GROUPS: {
  group: SecurityEventGroup;
  hint: string;
  title: string;
  tone: 'brick' | 'amber';
}[] = [
  {
    group: 'blocked',
    hint: 'A scanner stopped the agent from doing this.',
    title: 'Blocked',
    tone: 'brick',
  },
  {
    group: 'advisory',
    hint: 'A scanner flagged this, and the work went on.',
    title: 'Advisory',
    tone: 'amber',
  },
];

function sum(counts: Partial<Record<SecurityEventType, number>>, types: SecurityEventType[]) {
  return types.reduce((n, t) => n + (counts[t] ?? 0), 0);
}

/** Counts in the window per group, each with its change from the window before. */
function SummaryGroups({
  summary,
  windowDays,
}: {
  summary: SecurityEventSummary;
  windowDays: number | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {GROUPS.map(({ group, hint, title, tone }) => {
        const types = SECURITY_EVENT_TYPES.filter((t) => SECURITY_EVENT_META[t].group === group);
        const now = sum(summary.counts, types);
        const before = summary.previous ? sum(summary.previous, types) : null;
        return (
          <Card key={group}>
            <CardHeader>
              <CardTitle>{title}</CardTitle>
            </CardHeader>
            <Stat
              delta={formatDelta(now, before, {
                higherIsBetter: false,
                noun: windowDays ? `vs previous ${windowDays} days` : 'vs the window before',
              })}
              hint={hint}
              label={`${title} events`}
              tone={now > 0 ? tone : 'default'}
              value={now}
            />
            <ul className="mt-4 space-y-1.5">
              {types.map((type) => {
                const count = summary.counts[type] ?? 0;
                const prev = summary.previous?.[type];
                const arrow = prev === undefined || prev === count ? '' : count > prev ? '▲' : '▼';
                return (
                  <li className="flex items-center gap-2 text-xs" key={type}>
                    <SecurityEventBadge type={type} />
                    <span className="font-mono text-paper-300">{count}</span>
                    {arrow && (
                      <span
                        className="font-mono text-[10px] text-paper-500"
                        title={`${prev} in the window before`}
                      >
                        {arrow} from {prev}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

function SecurityWorkspace() {
  const { params, update } = useUrlParams();
  const range = parseDateRange(params);
  const bounds = dayBounds(range);
  const rawType = params.get('type');
  const typeFilter = (SECURITY_EVENT_TYPES as string[]).includes(rawType ?? '')
    ? (rawType as SecurityEventType)
    : '';
  const rawOffset = Number(params.get('offset') ?? 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const {
    data: page,
    isLoading,
    isError,
    error: loadError,
  } = useSecurityEvents({ ...bounds, limit: LIMIT, offset, type: typeFilter || undefined });
  const { data: summary } = useSecurityEventSummary(bounds);
  const events = page?.data ?? [];
  const total = page?.meta.total ?? 0;

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-56 shrink-0">
              <Select
                aria-label="Filter by event type"
                onChange={(v) => update({ offset: null, type: v || null })}
                options={TYPE_OPTIONS}
                value={typeFilter}
              />
            </div>
            <DateRangeControl
              onChange={(r) => r && update({ ...dateRangePatch(r), offset: null })}
              value={range}
            />
          </div>
        }
        chapter="§ Govern"
        subtitle="What the scanners stopped or flagged across all runs, newest first. Select an event with details to expand it. Events refresh every 30 seconds."
        title="Security events"
      />

      {summary && (
        <SummaryGroups summary={summary} windowDays={range.kind === 'preset' ? range.days : null} />
      )}

      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="security events"
      >
        <Card>
          <CardHeader>
            <CardTitle>
              {typeFilter
                ? `${TYPE_OPTIONS.find((o) => o.value === typeFilter)?.label} events`
                : 'All events'}
              {total > 0 && (
                <span className="ml-2 text-sm font-normal text-paper-400">· {total}</span>
              )}
            </CardTitle>
          </CardHeader>
          <SecurityEventList
            emptyMessage="No security events in this range. Events appear here when the agent triggers a scanner."
            events={events}
            showRunLink
          />
          {total > 0 && (
            <div className="pt-3 mt-3 border-t border-ink-600">
              <Pagination
                hasNext={offset + events.length < total}
                hasPrev={offset > 0}
                onNext={() => update({ offset: String(offset + LIMIT) })}
                onPrev={() =>
                  update({ offset: offset - LIMIT > 0 ? String(offset - LIMIT) : null })
                }
                rangeEnd={Math.min(offset + LIMIT, total)}
                rangeStart={offset + 1}
                total={total}
              />
            </div>
          )}
        </Card>
      </QueryBoundary>
    </div>
  );
}

export default function GovernSecurityPage() {
  return (
    <Suspense fallback={null}>
      <SecurityWorkspace />
    </Suspense>
  );
}
