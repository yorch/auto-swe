'use client';

import {
  RUN_ACTIVITY_KINDS,
  type RunActivityFilters,
  type RunActivityItem,
  type RunActivityKind,
} from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { exportRunActivity, useHttpCall, useRunActivity } from '@/hooks/useRunActivity';
import { errMsg } from '@/lib/errors';
import {
  recordingMatchesSelection,
  specNodeIdOfRecording,
  type TraceLinker,
} from '@/lib/traceLinkage';
import { formatDate } from '@/lib/utils';

function HttpDetail({ runId, callId }: { runId: string; callId: string }) {
  const query = useHttpCall(runId, callId);
  if (query.isLoading) {
    return <p role="status">Loading HTTP detail…</p>;
  }
  if (query.error) {
    return <Alert variant="error">{errMsg(query.error)}</Alert>;
  }
  if (!query.data) {
    return null;
  }
  const { requestBody, responseBody, ...metadata } = query.data;
  return (
    <div className="space-y-2 p-3 text-xs">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
        {JSON.stringify(metadata, null, 2)}
      </pre>
      {'requestBody' in query.data || 'responseBody' in query.data ? (
        <>
          <h4>Request body</h4>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
            {requestBody ?? 'No captured body'}
          </pre>
          <h4>Response body</h4>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
            {responseBody ?? 'No captured body'}
          </pre>
        </>
      ) : (
        <p>Bodies require run control or administrator access.</p>
      )}
    </div>
  );
}
function ActivityRow({ item, runId }: { item: RunActivityItem; runId: string }) {
  const [expanded, setExpanded] = useState(false);
  const line = (
    <>
      <time dateTime={item.ts} title={item.ts}>
        {formatDate(item.ts, { showSeconds: true })}
      </time>
      <Badge tone="muted">{item.kind.replaceAll('_', ' ')}</Badge>
      {item.kind === 'step' && item.detail.stepName && (
        <span className="text-paper-500">{item.detail.stepName}</span>
      )}
      <span className="min-w-0 break-all">
        {item.kind === 'http_call'
          ? `${item.detail.method} ${item.detail.host}${item.detail.path}`
          : item.summary}
      </span>
      {item.kind === 'http_call' && (
        <>
          <Badge
            tone={item.detail.status !== null && item.detail.status >= 400 ? 'danger' : 'muted'}
          >
            {item.detail.status ?? 'No status'}
          </Badge>
          {typeof item.detail.durationMs === 'number' && <span>{item.detail.durationMs} ms</span>}
          {item.detail.blocked && <Badge tone="danger">Blocked</Badge>}
        </>
      )}
    </>
  );
  return (
    <li
      className="border-b border-ink-700 py-2 text-xs"
      style={{ containIntrinsicSize: 'auto 48px', contentVisibility: 'auto' }}
    >
      {item.kind === 'http_call' ? (
        <button
          aria-expanded={expanded}
          className="flex w-full flex-wrap items-center gap-2 text-left hover:text-paper-100"
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          {line}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">{line}</div>
      )}
      {expanded && item.kind === 'http_call' && (
        <HttpDetail callId={item.detail.callId} runId={runId} />
      )}
    </li>
  );
}
function ActivityContent({
  runId,
  live,
  selection,
  linker,
  fanOutNodeIds,
}: {
  runId: string;
  live: boolean;
  selection: string | null;
  linker: TraceLinker;
  fanOutNodeIds?: ReadonlySet<string>;
}) {
  const [kinds, setKinds] = useState<RunActivityKind[]>([]);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const node = selection ? specNodeIdOfRecording(selection, linker) : null;
  const isFanOut = node !== null && fanOutNodeIds?.has(node);
  const filters: RunActivityFilters = {
    ...(kinds.length ? { kinds: kinds.join(',') } : {}),
    ...(selection
      ? !isFanOut && linker.specNodeIds.has(selection)
        ? { specNodeId: selection }
        : { recordingId: selection }
      : {}),
  };
  const query = useRunActivity(runId, filters, live);
  const data = query.data.filter(
    (item) =>
      !selection ||
      recordingMatchesSelection(
        item.recordingId ?? item.specNodeId ?? '',
        selection,
        linker,
        item.specNodeId ?? undefined
      )
  );
  return (
    <div className="space-y-3 pt-3">
      <fieldset aria-label="Activity kinds" className="flex flex-wrap gap-2">
        {RUN_ACTIVITY_KINDS.map((kind) => (
          <button
            aria-pressed={kinds.includes(kind)}
            className="rounded border border-ink-600 px-2 py-1 text-xs aria-pressed:bg-ink-600"
            key={kind}
            onClick={() =>
              setKinds((previous) =>
                previous.includes(kind)
                  ? previous.filter((value) => value !== kind)
                  : [...previous, kind]
              )
            }
            type="button"
          >
            {kind.replaceAll('_', ' ')}
          </button>
        ))}
      </fieldset>
      {selection && <p className="text-xs text-paper-400">Node: {selection}</p>}
      <Button
        disabled={exporting}
        onClick={async () => {
          setExportError(null);
          setExporting(true);
          try {
            await exportRunActivity(runId, filters);
          } catch (error) {
            setExportError(errMsg(error));
          } finally {
            setExporting(false);
          }
        }}
        size="sm"
        variant="secondary"
      >
        {exporting ? 'Exporting…' : 'Export activity'}
      </Button>
      {exportError && <Alert variant="error">{exportError}</Alert>}
      {query.error && <Alert variant="error">{errMsg(query.error)}</Alert>}
      {query.isLoading ? (
        <p role="status">Loading activity…</p>
      ) : !data.length ? (
        // A failed query is reported by the alert above, not as "no matches".
        query.error ? null : (
          <p className="text-sm text-paper-500">No activity matches these filters.</p>
        )
      ) : (
        <section aria-label="Run activity" className="max-h-96 overflow-auto">
          <ol>
            {data.map((item) => (
              <ActivityRow item={item} key={item.id} runId={runId} />
            ))}
          </ol>
        </section>
      )}
      {query.hasNextPage && (
        <Button
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
          size="sm"
          variant="secondary"
        >
          Load more activity
        </Button>
      )}
    </div>
  );
}
export function RunActivity(props: {
  runId: string;
  live: boolean;
  selection: string | null;
  linker: TraceLinker;
  fanOutNodeIds?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="shrink-0 border-b border-ink-700 bg-ink-900 px-4 py-3 text-paper-300"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">Activity</summary>
      {open && <ActivityContent {...props} />}
    </details>
  );
}
