'use client';

import Link from 'next/link';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DateRangeControl } from '@/components/ui/DateRangeControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { Toolbar } from '@/components/ui/Toolbar';
import {
  type TranscriptAccessAction,
  type TranscriptAccessFilters,
  type TranscriptAccessOutcome,
  type TranscriptAccessRow,
  useTranscriptAccessLog,
} from '@/hooks/useTranscripts';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { customRangeIgnored, dateRangePatch, dayBounds, parseDateRange } from '@/lib/dateRange';
import { cn, FOCUS_RING } from '@/lib/utils';

const LIMIT = 50;

// The gateway rejects a malformed id with a 400 that would replace the whole list with an
// error; a hand-edited or stale link instead just drops the filter.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTION_LABEL: Record<TranscriptAccessAction, string> = {
  content_read: 'Read',
  download_link: 'Link issued',
  export: 'Exported',
  legal_hold_cleared: 'Hold released',
  legal_hold_set: 'Hold placed',
  verify: 'Verified',
};

const ACTION_TONE: Record<TranscriptAccessAction, BadgeTone> = {
  content_read: 'info',
  download_link: 'info',
  export: 'accent',
  legal_hold_cleared: 'neutral',
  legal_hold_set: 'warning',
  verify: 'success',
};

const ACTION_OPTIONS = [
  { label: 'All actions', value: '' },
  ...(Object.keys(ACTION_LABEL) as TranscriptAccessAction[]).map((value) => ({
    label: ACTION_LABEL[value],
    value,
  })),
];

const OUTCOME_LABEL: Record<TranscriptAccessOutcome, string> = {
  aborted: 'Client left',
  denied: 'Refused',
  integrity_error: 'Integrity error',
  ok: 'Completed',
  started: 'In progress',
  stream_error: 'Stream error',
};

const OUTCOME_TONE: Record<TranscriptAccessOutcome, BadgeTone> = {
  aborted: 'warning',
  denied: 'danger',
  integrity_error: 'danger',
  ok: 'success',
  started: 'muted',
  stream_error: 'danger',
};

/** The URL keys this view filters on, so switching away can clear them. */
export const TRANSCRIPT_ACCESS_FILTER_KEYS = [
  'action',
  'actor',
  'transcript',
  'run',
  'range',
  'from',
  'to',
  'offset',
] as const;

/** `key: value` for each recorded parameter worth showing, in a stable order. */
function paramSummary(params: Record<string, unknown> | null): string {
  if (!params) {
    return '—';
  }
  const parts = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return parts.length ? parts.join('; ') : '—';
}

function FilterChip({
  label,
  title,
  onRemove,
  removeLabel,
}: {
  label: string;
  title?: string;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-ink-400 bg-ink-700 py-0.5 pr-1 pl-2 text-xs text-paper-200"
      title={title}
    >
      {label}
      <button
        aria-label={removeLabel}
        className={cn('rounded-sm p-0.5 text-paper-500 hover:text-paper-100', FOCUS_RING)}
        onClick={onRemove}
        type="button"
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

/** An id as a filter button: clicking it narrows the log to that value. */
function IdFilterButton({
  id,
  label,
  onFilter,
}: {
  id: string;
  label: string;
  onFilter: (id: string) => void;
}) {
  return (
    <button
      className={cn(
        'rounded-sm text-left font-mono text-xs text-paper-200 underline-offset-2 hover:underline focus-visible:underline',
        FOCUS_RING
      )}
      onClick={() => onFilter(id)}
      title={`${id} — show only this ${label}`}
      type="button"
    >
      {id.slice(0, 8)}…
    </button>
  );
}

/**
 * Who read, exported, verified or held agent transcripts — the
 * `TranscriptAccessLog` table, newest first, filtered from the URL.
 */
export function TranscriptAccessLog() {
  const { params, update } = useUrlFilters();
  const range = params.get('range') ? parseDateRange(params) : null;
  const offset = parseOffset(params.get('offset'));
  const rawAction = params.get('action');
  const uuidParam = (key: string) =>
    UUID_RE.test(params.get(key) ?? '') ? (params.get(key) ?? undefined) : undefined;
  const actorParam = params.get('actor');
  // Whole UTC days, as the gateway's from (inclusive) and to (exclusive) instants.
  const bounds = range ? dayBounds(range) : null;
  const filters: TranscriptAccessFilters = {
    action:
      rawAction && Object.hasOwn(ACTION_LABEL, rawAction)
        ? (rawAction as TranscriptAccessAction)
        : undefined,
    actorId: actorParam ? actorParam.slice(0, 200) : undefined,
    from: bounds?.since,
    runId: uuidParam('run'),
    to: bounds?.until,
    transcriptId: uuidParam('transcript'),
  };
  const { data, isLoading, isError, isFetching, refetch, error } = useTranscriptAccessLog({
    ...filters,
    limit: LIMIT,
    offset,
  });
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  /** Every filter change starts again from the first page. */
  function setFilter(patch: Record<string, string | null>) {
    update({ ...patch, offset: null });
  }

  const hasFilters = Boolean(
    filters.action || filters.actorId || filters.runId || filters.transcriptId || range
  );
  const filteredActor = filters.actorId
    ? (rows.find((r) => r.actorId === filters.actorId)?.actor?.email ?? 'one person')
    : null;
  const clearFilters = () =>
    update(Object.fromEntries(TRANSCRIPT_ACCESS_FILTER_KEYS.map((k) => [k, null])));

  return (
    <Card className="fade-up stagger-1 p-4 sm:p-6">
      <Toolbar
        end={
          total > 0 && (
            <span className="text-xs text-paper-500 tabular-nums">
              {total} {total === 1 ? 'entry' : 'entries'}
            </span>
          )
        }
      >
        <Select
          aria-label="Filter by access"
          className="h-8 w-full text-sm sm:w-40"
          onChange={(v) => setFilter({ action: v || null })}
          options={ACTION_OPTIONS}
          value={filters.action ?? ''}
        />
      </Toolbar>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <DateRangeControl
          allowAll
          onChange={(r) =>
            // No range in the URL means all time, so a preset is always written out.
            setFilter(r ? dateRangePatch(r, -1) : { from: null, range: null, to: null })
          }
          rangeIgnored={customRangeIgnored(params)}
          value={range}
        />
        {filteredActor && (
          <FilterChip
            label={`Actor: ${filteredActor}`}
            onRemove={() => setFilter({ actor: null })}
            removeLabel="Remove the actor filter"
            title={filters.actorId}
          />
        )}
        {filters.transcriptId && (
          <FilterChip
            label={`Transcript: ${filters.transcriptId.slice(0, 8)}…`}
            onRemove={() => setFilter({ transcript: null })}
            removeLabel="Remove the transcript filter"
            title={filters.transcriptId}
          />
        )}
        {filters.runId && (
          <FilterChip
            label={`Run: ${filters.runId.slice(0, 8)}…`}
            onRemove={() => setFilter({ run: null })}
            removeLabel="Remove the run filter"
            title={filters.runId}
          />
        )}
        {hasFilters && (
          <Button onClick={clearFilters} size="sm" variant="ghost">
            Clear filters
          </Button>
        )}
      </div>

      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="transcript access log"
        onRetry={() => void refetch()}
        rows={8}
      >
        {rows.length === 0 ? (
          hasFilters ? (
            <EmptyState
              action={
                <Button onClick={clearFilters} size="sm">
                  Clear filters
                </Button>
              }
              hint="Try a wider date range or fewer filters."
              icon="search"
              title="No transcript access matches these filters"
            />
          ) : (
            <EmptyState
              hint="Entries appear when someone reads, exports, verifies or holds a transcript."
              icon="list"
              title="No transcript access yet"
            />
          )
        ) : (
          <Table stacked>
            <THead>
              <Th className="pl-0" variant="plain">
                Access
              </Th>
              <Th variant="plain">Actor</Th>
              <Th variant="plain">Target</Th>
              <Th variant="plain">Outcome</Th>
              <Th variant="plain">Details</Th>
              <Th className="pr-0" variant="plain">
                When
              </Th>
            </THead>
            <tbody>
              {rows.map((row) => (
                <AccessRow key={row.id} onFilter={setFilter} row={row} />
              ))}
            </tbody>
          </Table>
        )}
      </QueryBoundary>
      {total > 0 && (
        <div className="mt-4 border-t border-ink-600 pt-4">
          <Pagination
            hasNext={offset + rows.length < total}
            hasPrev={offset > 0}
            onNext={() => update({ offset: String(offset + LIMIT) })}
            onPrev={() => update({ offset: offset - LIMIT > 0 ? String(offset - LIMIT) : null })}
            rangeEnd={Math.min(offset + LIMIT, total)}
            rangeStart={offset + 1}
            total={total}
          />
        </div>
      )}
    </Card>
  );
}

function AccessRow({
  row,
  onFilter,
}: {
  row: TranscriptAccessRow;
  onFilter: (patch: Record<string, string | null>) => void;
}) {
  const actorId = row.actorId;
  return (
    <TRow hover>
      <Td className="py-3 pr-4" primary>
        <Badge tone={ACTION_TONE[row.action] ?? 'neutral'} variant="outline">
          {ACTION_LABEL[row.action] ?? row.action}
        </Badge>
      </Td>
      <Td className="px-4 py-3" label="Actor">
        {actorId ? (
          <button
            className={cn(
              'rounded-sm text-left text-sm text-paper-200 underline-offset-2 hover:underline focus-visible:underline',
              FOCUS_RING
            )}
            onClick={() => onFilter({ actor: actorId })}
            title={`${actorId} — show only this actor`}
            type="button"
          >
            {row.actor?.email ?? `${actorId.slice(0, 8)}…`}
          </button>
        ) : (
          <span className="text-sm text-paper-500">Unknown</span>
        )}
      </Td>
      <Td className="px-4 py-3" label="Target">
        <div className="flex flex-col gap-0.5 text-xs text-paper-400">
          {row.scope === 'export' && <span>Export across all transcripts</span>}
          {row.transcriptId && (
            <span>
              Transcript{' '}
              <IdFilterButton
                id={row.transcriptId}
                label="transcript"
                onFilter={(id) => onFilter({ transcript: id })}
              />
            </span>
          )}
          {row.runId && (
            <span className="inline-flex items-center gap-1">
              Run{' '}
              <IdFilterButton id={row.runId} label="run" onFilter={(id) => onFilter({ run: id })} />
              <Link
                aria-label={`Open run ${row.runId}`}
                className={cn('rounded-sm text-paper-500 hover:text-paper-100', FOCUS_RING)}
                href={`/runs/${row.runId}`}
              >
                <Icon name="chevronRight" size={12} />
              </Link>
            </span>
          )}
        </div>
      </Td>
      <Td className="px-4 py-3" label="Outcome">
        <Badge tone={OUTCOME_TONE[row.outcome] ?? 'neutral'} variant="text">
          {OUTCOME_LABEL[row.outcome] ?? row.outcome}
        </Badge>
      </Td>
      <Td
        className="px-4 py-3 font-mono text-xs break-words text-paper-300 sm:max-w-sm"
        label="Details"
      >
        {paramSummary(row.params)}
      </Td>
      <Td className="py-3 pl-4 text-sm text-paper-400" label="When">
        <RelativeTime value={row.createdAt} />
      </Td>
    </TRow>
  );
}
