'use client';

import type { AgentTraceRecord, WorkflowRunDetail } from '@auto-swe/shared/types/api';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { use, useMemo, useState } from 'react';
import { HumanStepCard } from '@/components/inbox/HumanStepCard';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import { useCancelWorkflowRun, useInbox, useWorkflowRun } from '@/hooks/useWorkflows';
import { formatDate, formatDuration, formatRelativeTime } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

// ── Agent trace helpers ──────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  bash: 'bash',
  listDirectory: 'ls',
  readFile: 'read',
  writeFile: 'write',
};

const TYPE_DOT: Record<string, string> = {
  activity_event: 'bg-blue-500',
  llm_response: 'bg-purple-500',
  tool_call: 'bg-gray-400',
};

const TYPE_BADGE: Record<string, string> = {
  activity_event: 'bg-blue-100 text-blue-700',
  llm_response: 'bg-purple-100 text-purple-700',
  tool_call: 'bg-gray-100 text-gray-600',
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
  if (!input) {
    return { detail: '', label: TOOL_LABELS[name] ?? name };
  }
  switch (name) {
    case 'readFile':
    case 'writeFile':
      return { detail: String(input.path ?? ''), label: TOOL_LABELS[name] ?? name };
    case 'listDirectory':
      return { detail: String(input.path ?? '.'), label: 'ls' };
    case 'bash':
      return { detail: String(input.command ?? '').slice(0, 80), label: 'bash' };
    default:
      return { detail: '', label: TOOL_LABELS[name] ?? (name || 'call') };
  }
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
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 mb-1">
          {trace.error}
        </div>
      )}
      {text && (
        <pre className="text-[10px] leading-tight bg-[var(--muted)] p-1.5 rounded overflow-x-auto max-h-28 whitespace-pre-wrap break-all">
          {text.slice(0, 1200)}
          {text.length > 1200 ? '\n…' : ''}
        </pre>
      )}
    </div>
  );
}

function AgentTracePanel({ traces }: { traces: AgentTraceRecord[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (traces.length === 0) {
    return <p className="text-xs text-[var(--muted-foreground)] py-1">No trace events recorded.</p>;
  }

  // Group by attempt so retries are visually separated
  const byAttempt = traces.reduce<Record<number, AgentTraceRecord[]>>((acc, t) => {
    const a = t.attempt ?? 1;
    if (!acc[a]) {
      acc[a] = [];
    }
    acc[a].push(t);
    return acc;
  }, {});
  const attempts = Object.keys(byAttempt)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <div className="space-y-2">
      {attempts.map((attempt) => (
        <div key={attempt}>
          {attempts.length > 1 && (
            <p className="text-[10px] font-semibold text-[var(--muted-foreground)] uppercase tracking-wide mb-1">
              Attempt {attempt}
            </p>
          )}
          <ol className="space-y-1 max-h-80 overflow-y-auto">
            {byAttempt[attempt].map((t) => {
              const { label, detail } = traceSummary(t);
              const isExpanded = expandedId === t.id;
              const durationLabel =
                t.durationMs != null && t.durationMs > 0 ? formatDuration(t.durationMs) : '';
              const badgeClass = TYPE_BADGE[t.type] ?? TYPE_BADGE.tool_call;
              const dotClass = TYPE_DOT[t.type] ?? TYPE_DOT.tool_call;

              return (
                <li key={t.id}>
                  <button
                    className="w-full text-left rounded hover:bg-[var(--muted)] px-2 py-1 transition-colors"
                    onClick={() => setExpandedId(isExpanded ? null : t.id)}
                    type="button"
                  >
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className={`inline-block w-2 h-2 rounded-sm shrink-0 ${dotClass}`} />
                      <span className={`text-[10px] px-1 rounded font-mono shrink-0 ${badgeClass}`}>
                        {t.type === 'tool_call'
                          ? 'tool'
                          : t.type === 'llm_response'
                            ? 'llm'
                            : 'event'}
                      </span>
                      <span className="font-mono font-semibold shrink-0">{label}</span>
                      {detail && (
                        <span className="text-[var(--muted-foreground)] truncate font-mono">
                          {detail}
                        </span>
                      )}
                      <span className="ml-auto text-[var(--muted-foreground)] shrink-0 text-[10px]">
                        {durationLabel}
                      </span>
                      {t.error && (
                        <span className="text-red-600 shrink-0 text-[10px] font-mono">err</span>
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
        </div>
      ))}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function RunDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const { data: run, isLoading } = useWorkflowRun(id);
  const cancelRun = useCancelWorkflowRun(id);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const { data: inboxSteps } = useInbox();
  const pendingSteps = useMemo(
    () => (inboxSteps ?? []).filter((s) => s.runId === id),
    [inboxSteps, id]
  );

  const dagOverlay = useMemo(() => {
    if (!run?.steps) {
      return undefined;
    }
    const byNodeId: Record<string, { status: string; attempt: number }> = {};
    for (const s of run.steps) {
      const baseId = s.nodeId.includes('/') ? (s.nodeId.split('/').pop() ?? s.nodeId) : s.nodeId;
      const existing = byNodeId[baseId];
      if (!existing || s.attempt >= existing.attempt) {
        byNodeId[baseId] = { attempt: s.attempt, status: s.status };
      }
    }
    return { byNodeId };
  }, [run?.steps]);

  // Traces for the currently selected node — derived directly from spec + selected node id
  const nodeTraces = useMemo<AgentTraceRecord[]>(() => {
    if (!selectedNodeId || !run?.traces || !run?.specSnapshot) {
      return [];
    }
    const spec = run.specSnapshot as WorkflowSpec;
    const node = spec.nodes[selectedNodeId];
    if (node?.type !== 'step') {
      return [];
    }
    return (run as WorkflowRunDetail).traces.filter((t) => t.nodeId === node.step);
  }, [selectedNodeId, run?.traces, run?.specSnapshot]);

  if (isLoading || !run) {
    return <LoadingState />;
  }

  const spec = run.specSnapshot as WorkflowSpec;
  const nodeRecords =
    selectedNodeId && run.steps
      ? run.steps.filter(
          (s) => s.nodeId === selectedNodeId || s.nodeId.endsWith(`/${selectedNodeId}`)
        )
      : [];

  const totalTraces = (run as WorkflowRunDetail).traces?.length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link className="text-[var(--primary)] hover:underline text-sm" href="/templates">
            &larr; Templates
          </Link>
          <h2 className="text-2xl font-bold">Run · {run.templateName}</h2>
          <StatusBadge status={run.status} />
          <span className="text-xs text-[var(--muted-foreground)]">
            v{run.templateVersion} · {formatRelativeTime(run.startedAt)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {run.status === 'RUNNING' && (
            <button
              className="text-sm px-3 py-1.5 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
              disabled={cancelRun.isPending}
              onClick={() => {
                if (window.confirm('Cancel this run? In-flight steps will be aborted.')) {
                  cancelRun.mutate();
                }
              }}
              type="button"
            >
              {cancelRun.isPending ? 'Cancelling…' : 'Cancel run'}
            </button>
          )}
          <Link
            className="text-sm text-[var(--muted-foreground)] hover:underline"
            href={`/templates/${run.templateId}`}
          >
            View template →
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Execution graph</CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <WorkflowDag
              onSelect={setSelectedNodeId}
              selectedNodeId={selectedNodeId}
              spec={spec}
              statuses={dagOverlay}
            />
          </div>
          <div className="flex flex-wrap gap-3 mt-4 text-xs text-[var(--muted-foreground)]">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded bg-[#3b82f6]" /> Running
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded bg-[#16a34a]" /> Passed
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded bg-[#dc2626]" /> Failed
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded bg-[#9ca3af]" /> Skipped
            </span>
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Run details</CardTitle>
            </CardHeader>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-[var(--muted-foreground)]">Started</dt>
                <dd>{formatDate(run.startedAt)}</dd>
              </div>
              {run.endedAt && (
                <div className="flex justify-between">
                  <dt className="text-[var(--muted-foreground)]">Ended</dt>
                  <dd>{formatDate(run.endedAt)}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-[var(--muted-foreground)]">Workflow ID</dt>
                <dd className="font-mono text-xs">{run.workflowId}</dd>
              </div>
              {totalTraces > 0 && (
                <div className="flex justify-between">
                  <dt className="text-[var(--muted-foreground)]">Tool calls</dt>
                  <dd className="font-mono text-xs">{totalTraces}</dd>
                </div>
              )}
              {run.workRequest && (
                <>
                  <div className="flex justify-between">
                    <dt className="text-[var(--muted-foreground)]">Ticket</dt>
                    <dd className="font-mono text-xs">{run.workRequest.externalTicketId}</dd>
                  </div>
                  <div className="text-xs text-[var(--muted-foreground)] pt-1 border-t border-[var(--border)]">
                    {run.workRequest.description}
                  </div>
                </>
              )}
            </dl>
          </Card>

          {selectedNodeId && (
            <Card>
              <CardHeader>
                <CardTitle>Node · {selectedNodeId}</CardTitle>
              </CardHeader>
              {nodeRecords.length === 0 ? (
                <p className="text-sm text-[var(--muted-foreground)]">
                  No execution record yet — this node has not run.
                </p>
              ) : (
                <div className="space-y-3">
                  {nodeRecords.map((s) => (
                    <div className="border-b border-[var(--border)] pb-2 last:border-0" key={s.id}>
                      <div className="flex items-center justify-between">
                        <StatusBadge status={s.status} />
                        <span className="text-xs text-[var(--muted-foreground)]">
                          attempt {s.attempt}
                        </span>
                      </div>
                      <div className="text-xs text-[var(--muted-foreground)] mt-1">{s.nodeId}</div>
                      {s.error && (
                        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 mt-2">
                          {s.error}
                        </div>
                      )}
                      {(s.startedAt || s.endedAt) && (
                        <div className="text-xs text-[var(--muted-foreground)] mt-1">
                          {s.startedAt ? formatDate(s.startedAt) : '?'}
                          {s.endedAt ? ` → ${formatDate(s.endedAt)}` : ''}
                        </div>
                      )}
                      {s.outputs !== null && s.outputs !== undefined && (
                        <details className="mt-2">
                          <summary className="text-xs cursor-pointer">Outputs</summary>
                          <pre className="text-xs bg-[var(--muted)] p-2 rounded overflow-x-auto mt-1">
                            {JSON.stringify(s.outputs, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {nodeTraces.length > 0 && (
                <div className="mt-4 pt-3 border-t border-[var(--border)]">
                  <p className="text-xs font-semibold text-[var(--muted-foreground)] mb-2 uppercase tracking-wide">
                    Agent trace · {nodeTraces.length} event{nodeTraces.length !== 1 ? 's' : ''}
                  </p>
                  <AgentTracePanel traces={nodeTraces} />
                </div>
              )}
            </Card>
          )}

          {pendingSteps.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Pending actions · {pendingSteps.length}</CardTitle>
              </CardHeader>
              <div className="space-y-3">
                {pendingSteps.map((step) => (
                  <HumanStepCard key={step.id} showRunLink={false} step={step} />
                ))}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Step log</CardTitle>
            </CardHeader>
            <ul className="space-y-1 text-xs max-h-96 overflow-y-auto">
              {run.steps.map((s) => (
                <li key={s.id}>
                  <button
                    className={`w-full flex items-center justify-between py-1 px-2 rounded hover:bg-[var(--muted)] ${
                      selectedNodeId === s.nodeId ? 'bg-[var(--muted)]' : ''
                    }`}
                    onClick={() => setSelectedNodeId(s.nodeId)}
                    type="button"
                  >
                    <span className="font-mono truncate">{s.nodeId}</span>
                    <StatusBadge status={s.status} />
                  </button>
                </li>
              ))}
              {run.steps.length === 0 && (
                <li className="text-[var(--muted-foreground)]">No steps recorded yet</li>
              )}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
