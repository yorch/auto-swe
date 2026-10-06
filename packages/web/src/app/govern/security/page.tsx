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
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Stat } from '@/components/ui/Stat';
import type { SecurityEventSummary, SecurityEventType } from '@/hooks/useAdmin';
import { useSecurityEventSummary, useSecurityEvents } from '@/hooks/useAdmin';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { customRangeIgnored, dateRangePatch, dayBounds, parseDateRange } from '@/lib/dateRange';
import { formatDelta } from '@/lib/delta';
import { cn, FOCUS_RING } from '@/lib/utils';

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
  activeType,
  onSelectType,
  summary,
  windowDays,
}: {
  activeType: SecurityEventType | '';
  onSelectType: (type: SecurityEventType | '') => void;
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
              label="Total"
              tone={now > 0 ? tone : 'default'}
              value={now}
            />
            <ul className="mt-5 divide-y divide-ink-600 border-t border-ink-600">
              {types.map((type) => {
                const count = summary.counts[type] ?? 0;
                const prev = summary.previous?.[type];
                const change =
                  prev === undefined || prev === count ? null : count > prev ? 'up' : 'down';
                const selected = activeType === type;
                return (
                  <li key={type}>
                    <button
                      aria-pressed={selected}
                      className={cn(
                        '-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-ink-600/40',
                        selected && 'bg-ink-600/50',
                        FOCUS_RING
                      )}
                      onClick={() => onSelectType(selected ? '' : type)}
                      title={selected ? 'Show all types' : 'Show only this type'}
                      type="button"
                    >
                      <SecurityEventBadge type={type} />
                      {change && (
                        <span
                          className="inline-flex items-center gap-0.5 text-paper-500"
                          title={`${prev} in the window before`}
                        >
                          <Icon
                            className={change === 'up' ? '-rotate-90' : 'rotate-90'}
                            name="arrowRight"
                            size={11}
                          />
                          from {prev}
                        </span>
                      )}
                      <span
                        className={cn(
                          'ml-auto text-sm tabular-nums',
                          count > 0 ? 'text-paper-100' : 'text-paper-500'
                        )}
                      >
                        {count}
                      </span>
                    </button>
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
  const { params, update } = useUrlFilters();
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
    isFetching,
    refetch,
    error: loadError,
  } = useSecurityEvents({ ...bounds, limit: LIMIT, offset, type: typeFilter || undefined });
  const { data: summary } = useSecurityEventSummary(bounds);
  const events = page?.data ?? [];
  const total = page?.meta.total ?? 0;

  const setType = (type: SecurityEventType | '') => update({ offset: null, type: type || null });

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <DateRangeControl
            onChange={(r) => r && update({ ...dateRangePatch(r), offset: null })}
            rangeIgnored={customRangeIgnored(params)}
            value={range}
          />
        }
        subtitle="What the scanners stopped or flagged across all runs, newest first. Expand an event to see its detail. Events refresh every 30 seconds."
        title="Security events"
      />

      {summary ? (
        <SummaryGroups
          activeType={typeFilter}
          onSelectType={setType}
          summary={summary}
          windowDays={range.kind === 'preset' ? range.days : null}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {['blocked', 'advisory'].map((k) => (
            <Card key={k}>
              <SkeletonRows rows={3} />
            </Card>
          ))}
        </div>
      )}

      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={false}
        label="security events"
        onRetry={() => void refetch()}
      >
        <Card className="p-4 sm:p-6">
          <CardHeader>
            <CardTitle>
              {typeFilter
                ? `${TYPE_OPTIONS.find((o) => o.value === typeFilter)?.label} events`
                : 'All events'}
              {total > 0 && (
                <span className="ml-2 text-sm font-normal text-paper-400 tabular-nums">
                  · {total}
                </span>
              )}
            </CardTitle>
            <div className="w-full sm:w-60">
              <Select
                aria-label="Filter by event type"
                className="h-8 text-[13px]"
                onChange={(v) => setType(v as SecurityEventType | '')}
                options={TYPE_OPTIONS}
                value={typeFilter}
              />
            </div>
          </CardHeader>
          {isLoading ? (
            <SkeletonRows rows={6} />
          ) : (
            <SecurityEventList
              emptyHint={
                typeFilter
                  ? 'Choose All types, or widen the date range.'
                  : 'Events appear here when an agent triggers a scanner. Widen the date range to look further back.'
              }
              emptyMessage={
                typeFilter
                  ? 'No events of this type in this range'
                  : 'No security events in this range'
              }
              events={events}
              showRunLink
            />
          )}
          {total > 0 && (
            <div className="mt-4 border-t border-ink-600 pt-4">
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
