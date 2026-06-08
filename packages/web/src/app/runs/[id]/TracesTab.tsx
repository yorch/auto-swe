'use client';

import { useCallback, useMemo, useState } from 'react';
import type { AgentTraceRecord } from '@auto-swe/shared/types/api';
import { formatDuration } from '@/lib/utils';

// ── Trace helpers ─────────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  bash: 'bash',
  listDirectory: 'ls',
  readFile: 'read',
  writeFile: 'write',
};

const TYPE_DOT: Record<string, string> = {
  activity_event: 'bg-dust-400',
  llm_response: 'bg-violet-400',
  tool_call: 'bg-paper-500',
};

const TYPE_BADGE: Record<string, string> = {
  activity_event: 'bg-dust-400/20 text-dust-400',
  llm_response: 'bg-violet-400/20 text-violet-400',
  tool_call: 'bg-ink-600 text-paper-400',
};

function traceSummary(trace: AgentTraceRecord): { label: string; detail: string } {
  const input = trace.inputJson as Record<string, unknown> | null;
  const name = trace.toolName ?? '';

  if (trace.type === 'llm_response') {
    return { detail: trace.agentRole, label: name || trace.agentRole };
  }

  if (trace.type === 'activity_event') {
    const output = trace.outputJson as Record<string, unknown> | null;
    let detail = '';
    if (name === 'tdd.test_run' && output) {
      detail = output.passed
        ? `pass ${output.passing}/${output.total}`
        : `fail ${output.failing}/${output.total ?? 0}`;
    } else if ((name === 'pr.created' || name === 'pr.updated') && output) {
      detail = output.prUrl ? String(output.prUrl) : `#${output.prNumber}`;
    } else if (name === 'git.commit_push' && output) {
      detail = String(output.headSha ?? '').slice(0, 8);
    } else if (name === 'lessons.retrieved' && output) {
      detail = `${output.count} lesson${Number(output.count) !== 1 ? 's' : ''}`;
    }
    return { detail, label: TOOL_LABELS[name] ?? name };
  }

  // tool_call
  const label = TOOL_LABELS[name] ?? (name || 'call');
  if (!input) {
    return { detail: '', label };
  }
  if (name === 'readFile' || name === 'writeFile') {
    return { detail: String(input.path ?? ''), label };
  }
  if (name === 'listDirectory') {
    return { detail: String(input.path ?? '.'), label };
  }
  if (name === 'bash') {
    return { detail: String(input.command ?? '').slice(0, 80), label };
  }
  return { detail: '', label };
}

const OUTPUT_TEXT_FIELDS = ['text', 'output', 'content', 'listing', 'result'] as const;

function TraceOutput({ trace }: { trace: AgentTraceRecord }) {
  const output = trace.outputJson as Record<string, unknown> | null;
  const text = output
    ? ((OUTPUT_TEXT_FIELDS.map((k) => output[k]).find((v) => typeof v === 'string') as
        | string
        | undefined) ?? JSON.stringify(output, null, 2))
    : null;

  if (!trace.error && !text) {
    return null;
  }
  return (
    <div>
      {trace.error && (
        <div className="text-xs text-brick-400 bg-brick-400/10 border border-brick-400/40 rounded px-2 py-1 mb-1">
          {trace.error}
        </div>
      )}
      {text && (
        <pre className="text-[10px] leading-tight bg-ink-800 p-1.5 rounded overflow-x-auto max-h-40 whitespace-pre-wrap break-all">
          {text.slice(0, 2000)}
          {text.length > 2000 ? '\n…' : ''}
        </pre>
      )}
    </div>
  );
}

function TraceEventList({
  traces,
  expandedId,
  onToggle,
}: {
  traces: AgentTraceRecord[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <ol className="space-y-0.5">
      {traces.map((t) => {
        const { label, detail } = traceSummary(t);
        const isExpanded = expandedId === t.id;
        const durationLabel = t.durationMs != null ? formatDuration(t.durationMs) : '';
        const badgeClass = TYPE_BADGE[t.type] ?? TYPE_BADGE.tool_call;
        const dotClass = TYPE_DOT[t.type] ?? TYPE_DOT.tool_call;

        return (
          <li key={t.id}>
            <button
              className="w-full text-left rounded hover:bg-ink-700 px-2 py-1.5 transition-colors"
              onClick={() => onToggle(t.id)}
              type="button"
            >
              <div className="flex items-center gap-1.5 text-xs">
                <span className={`inline-block w-2 h-2 rounded-sm shrink-0 ${dotClass}`} />
                <span className={`text-[10px] px-1 rounded font-mono shrink-0 ${badgeClass}`}>
                  {t.type === 'tool_call' ? 'tool' : t.type === 'llm_response' ? 'llm' : 'event'}
                </span>
                <span className="font-mono font-semibold shrink-0">{label}</span>
                {detail && <span className="text-paper-400 truncate font-mono">{detail}</span>}
                <span className="ml-auto text-paper-400 shrink-0 text-[10px]">{durationLabel}</span>
                {t.error && (
                  <span className="text-brick-400 shrink-0 text-[10px] font-mono">err</span>
                )}
              </div>
              {isExpanded && (
                <div className="mt-1.5">
                  <TraceOutput trace={t} />
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ── Traces tab ────────────────────────────────────────────────────────────────

interface TraceGroup {
  activityName: string;
  dagNodeId: string | null;
  attempt: number;
  traces: AgentTraceRecord[];
}

export function TracesTab({
  traces,
  filterNodeId,
  activityToNodeId,
  onClearFilter,
  compact = false,
}: {
  traces: AgentTraceRecord[];
  filterNodeId: string | null;
  activityToNodeId: Record<string, string>;
  onClearFilter: () => void;
  compact?: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const handleToggle = useCallback(
    (id: string) => setExpandedId((prev) => (prev === id ? null : id)),
    []
  );

  const filtered = useMemo(
    () =>
      filterNodeId ? traces.filter((t) => activityToNodeId[t.nodeId] === filterNodeId) : traces,
    [traces, filterNodeId, activityToNodeId]
  );

  const groups = useMemo<TraceGroup[]>(() => {
    const seen = new Map<string, TraceGroup>();
    for (const t of filtered) {
      const key = `${t.nodeId}::${t.attempt}`;
      if (!seen.has(key)) {
        seen.set(key, {
          activityName: t.nodeId,
          attempt: t.attempt,
          dagNodeId: activityToNodeId[t.nodeId] ?? null,
          traces: [],
        });
      }
      seen.get(key)?.traces.push(t);
    }
    return [...seen.values()];
  }, [filtered, activityToNodeId]);

  if (traces.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-paper-400">
        No trace events recorded for this run.
      </div>
    );
  }

  return (
    <div>
      {!compact && filterNodeId && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-ink-600 bg-ink-800/60 sticky top-0 z-10">
          <span className="text-xs text-paper-400">
            Filtered to{' '}
            <span className="font-mono text-paper-200 bg-ink-600 px-1.5 py-0.5 rounded">
              {filterNodeId}
            </span>
          </span>
          <button
            className="text-xs text-ember-400 hover:underline"
            onClick={onClearFilter}
            type="button"
          >
            Show all
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="py-12 text-center text-sm text-paper-400">
          No trace events for this node.{' '}
          {!compact && (
            <button className="text-ember-400 hover:underline" onClick={onClearFilter} type="button">
              Show all traces
            </button>
          )}
        </div>
      ) : (
        <div className="divide-y divide-ink-600/50">
          {groups.map((group) => (
            <div key={`${group.activityName}-${group.attempt}`}>
              <div
                className={`flex items-center gap-2 px-4 py-2 bg-ink-800/40 sticky ${!compact && filterNodeId ? 'top-[33px]' : 'top-0'} z-[5]`}
              >
                <span className="text-xs font-semibold text-paper-100 font-mono">
                  {group.dagNodeId ?? group.activityName}
                </span>
                {group.dagNodeId && group.dagNodeId !== group.activityName && (
                  <span className="text-[10px] text-paper-400 font-mono">
                    ({group.activityName})
                  </span>
                )}
                <span className="text-[10px] text-paper-400">attempt {group.attempt}</span>
                <span className="text-[10px] text-paper-400 ml-auto">
                  {group.traces.length} event{group.traces.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="px-2 py-1">
                <TraceEventList
                  expandedId={expandedId}
                  onToggle={handleToggle}
                  traces={group.traces}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
