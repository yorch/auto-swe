'use client';

import { Suspense, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { DateRangeControl } from '@/components/ui/DateRangeControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type AssistantFailure,
  type AssistantFailureTrace,
  useAssistantFailure,
  useAssistantFailures,
} from '@/hooks/useAdmin';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { customRangeIgnored, dateRangePatch, dayBounds, parseDateRange } from '@/lib/dateRange';
import { cn, FOCUS_RING } from '@/lib/utils';

const LIMIT = 50;

function traceLabel(t: AssistantFailureTrace): string {
  if (t.type === 'tool_call') {
    return t.toolName ?? 'tool call';
  }
  if (t.type === 'llm_response') {
    return t.model ?? 'model call';
  }
  return t.toolName ?? t.type;
}

const TRACE_TYPE_LABEL: Record<string, string> = {
  activity_event: 'Event',
  llm_response: 'Model',
  tool_call: 'Tool',
};

/** The rows the failed turn wrote: what it called, how long it took, and what errored. */
function TurnTraces({ id }: { id: string }) {
  const { data, error, isError, isFetching, isLoading, refetch } = useAssistantFailure(id, true);
  return (
    <QueryBoundary
      error={error}
      isError={isError}
      isFetching={isFetching}
      isLoading={isLoading}
      label="the turn's traces"
      onRetry={() => void refetch()}
    >
      {data && data.traces.length === 0 ? (
        <p className="text-xs text-paper-400">
          This turn recorded no trace rows. It most likely failed before the model was called (a
          missing agent or provider credential) or never reached the worker — the cause above says
          which.
        </p>
      ) : (
        <Table>
          <THead>
            <tr>
              <Th className="px-4" variant="compact">
                When
              </Th>
              <Th className="px-4" variant="compact">
                Kind
              </Th>
              <Th className="px-4" variant="compact">
                Tool / model
              </Th>
              <Th align="right" className="px-4" variant="compact">
                Tokens in / out
              </Th>
              <Th align="right" className="px-4" variant="compact">
                Duration
              </Th>
              <Th className="px-4" variant="compact">
                Error
              </Th>
            </tr>
          </THead>
          <tbody>
            {data?.traces.map((t) => (
              <TRow hover={false} key={t.id}>
                <Td className="text-xs">
                  <RelativeTime value={t.createdAt} />
                </Td>
                <Td className="text-xs">{TRACE_TYPE_LABEL[t.type] ?? t.type}</Td>
                <Td className="font-mono text-xs">{traceLabel(t)}</Td>
                <Td align="right" className="text-xs tabular-nums">
                  {t.inputTokens === null && t.outputTokens === null
                    ? '—'
                    : `${t.inputTokens ?? 0} / ${t.outputTokens ?? 0}`}
                </Td>
                <Td align="right" className="text-xs tabular-nums">
                  {t.durationMs === null ? '—' : `${t.durationMs} ms`}
                </Td>
                <Td className={cn('text-xs', t.error ? 'text-danger-400' : 'text-paper-500')}>
                  {t.error ?? '—'}
                </Td>
              </TRow>
            ))}
          </tbody>
        </Table>
      )}
      {data?.traces.some((t) => t.otelTraceId) && (
        <p className="mt-2 text-xs text-paper-400">
          OpenTelemetry trace id{' '}
          <code className="font-mono text-paper-200">
            {data.traces.find((t) => t.otelTraceId)?.otelTraceId}
          </code>{' '}
          — search for it in Grafana Tempo for the full span.
        </p>
      )}
    </QueryBoundary>
  );
}

function FailureItem({ failure }: { failure: AssistantFailure }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-3">
      <button
        aria-expanded={open}
        className={cn(
          '-mx-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-md px-2 py-1 text-left hover:bg-ink-600/40',
          FOCUS_RING
        )}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <Icon
          className={cn('mt-1 shrink-0 text-paper-500', open && 'rotate-90')}
          name="chevronRight"
          size={12}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-paper-100">{failure.user.name ?? failure.user.email}</span>
            {failure.user.name && (
              <span className="text-xs text-paper-400">{failure.user.email}</span>
            )}
            <RelativeTime className="ml-auto text-xs text-paper-400" value={failure.failedAt} />
          </div>
          <p
            className={cn(
              'break-words font-mono text-xs',
              failure.errorDetail ? 'text-danger-400' : 'text-paper-400'
            )}
          >
            {failure.errorDetail ?? 'No cause was recorded for this reply.'}
          </p>
          <p className="text-xs text-paper-500">Shown to the user: {failure.error ?? '—'}</p>
        </div>
      </button>
      {open && (
        <div className="mt-3 space-y-3 pl-5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-paper-400">
            <Badge tone="muted" variant="outline">
              Temporal workflow
            </Badge>
            <code className="font-mono text-paper-200">{failure.workflowId}</code>
            <CopyButton value={failure.workflowId} />
          </div>
          <TurnTraces id={failure.id} />
        </div>
      )}
    </li>
  );
}

function AssistantFailuresWorkspace() {
  const { params, update } = useUrlFilters();
  const range = parseDateRange(params);
  const bounds = dayBounds(range);
  const rawOffset = Number(params.get('offset') ?? 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const {
    data: page,
    error,
    isError,
    isFetching,
    isLoading,
    refetch,
  } = useAssistantFailures({ ...bounds, limit: LIMIT, offset });
  const failures = page?.data ?? [];
  const total = page?.meta.total ?? 0;

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
        help={<p>Expand one to see what its turn called. Conversation text is never shown here.</p>}
        subtitle="Replies the in-app assistant could not finish, across every user, newest first, with the cause the platform recorded."
        title="Assistant failures"
      />

      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={false}
        label="assistant failures"
        onRetry={() => void refetch()}
      >
        <Card className="p-4 sm:p-6">
          <CardHeader>
            <CardTitle>
              Failed replies
              {total > 0 && (
                <span className="ml-2 text-sm font-normal text-paper-400 tabular-nums">
                  · {total}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          {isLoading ? (
            <SkeletonRows label="assistant failures" rows={6} />
          ) : failures.length === 0 ? (
            <EmptyState
              hint="A reply the assistant could not finish appears here. Widen the date range to look further back."
              title="No assistant failures in this range"
            />
          ) : (
            <ul className="divide-y divide-ink-600">
              {failures.map((f) => (
                <FailureItem failure={f} key={f.id} />
              ))}
            </ul>
          )}
          {total > 0 && (
            <div className="mt-4 border-t border-ink-600 pt-4">
              <Pagination
                hasNext={offset + failures.length < total}
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

export default function GovernAssistantFailuresPage() {
  return (
    <Suspense fallback={null}>
      <AssistantFailuresWorkspace />
    </Suspense>
  );
}
