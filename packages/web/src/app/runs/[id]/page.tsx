'use client';

import type {
  AgentTraceRecord,
  WorkflowRunDetail,
  WorkflowStepRecord,
} from '@auto-swe/shared/types/api';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import { HumanStepCard } from '@/components/inbox/HumanStepCard';
import {
  classifyTraceAsSecurityEvent,
  SecurityEventList,
} from '@/components/security/SecurityEventList';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { LoadingState } from '@/components/ui/LoadingState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import type { SecurityEvent } from '@/hooks/useAdmin';
import { useCancelWorkflowRun, useInbox, useWorkflowRun } from '@/hooks/useWorkflows';
import { formatDate, formatDuration, formatRelativeTime } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

type TabId = 'traces' | 'steps' | 'security';

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

function TracesTab({
  traces,
  filterNodeId,
  activityToNodeId,
  onClearFilter,
}: {
  traces: AgentTraceRecord[];
  filterNodeId: string | null;
  activityToNodeId: Record<string, string>;
  onClearFilter: () => void;
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
      {filterNodeId && (
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
          <button className="text-ember-400 hover:underline" onClick={onClearFilter} type="button">
            Show all traces
          </button>
        </div>
      ) : (
        <div className="divide-y divide-ink-600/50">
          {groups.map((group) => (
            <div key={`${group.activityName}-${group.attempt}`}>
              <div className="flex items-center gap-2 px-4 py-2 bg-ink-800/40 sticky top-[33px] z-[5]">
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

// ── Steps tab ─────────────────────────────────────────────────────────────────

function StepsTab({
  steps,
  onNodeClick,
}: {
  steps: WorkflowStepRecord[];
  onNodeClick: (nodeId: string) => void;
}) {
  if (steps.length === 0) {
    return <div className="py-12 text-center text-sm text-paper-400">No steps recorded yet.</div>;
  }

  return (
    <div className="divide-y divide-ink-600/50">
      {steps.map((s) => (
        <button
          className="w-full flex items-start gap-3 px-4 py-3 hover:bg-ink-800/40 transition-colors text-left group"
          key={s.id}
          onClick={() => onNodeClick(s.nodeId)}
          type="button"
        >
          <div className="pt-0.5 shrink-0">
            <StatusBadge status={s.status} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-mono text-paper-200 truncate">{s.nodeId}</span>
              <span className="text-xs text-paper-400 shrink-0">attempt {s.attempt}</span>
            </div>
            {s.error && <div className="text-xs text-brick-400 mt-0.5 truncate">{s.error}</div>}
            {(s.startedAt || s.endedAt) && (
              <div className="text-xs text-paper-400 mt-0.5">
                {s.startedAt ? formatDate(s.startedAt) : '?'}
                {s.endedAt ? ` → ${formatDate(s.endedAt)}` : ''}
              </div>
            )}
          </div>
          <span className="text-[10px] text-paper-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity pt-1">
            view traces →
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RunDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const { data: run, isLoading } = useWorkflowRun(id);
  const cancelRun = useCancelWorkflowRun(id);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('traces');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const { data: inboxSteps } = useInbox();

  const pendingSteps = useMemo(
    () => (inboxSteps ?? []).filter((s) => s.runId === id),
    [inboxSteps, id]
  );

  // Clicking a DAG node always switches to the traces tab
  useEffect(() => {
    if (selectedNodeId) {
      setActiveTab('traces');
    }
  }, [selectedNodeId]);

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

  const spec = run ? (run.specSnapshot as WorkflowSpec) : null;

  // activity name (e.g. "executeImplementation") → dag node id (e.g. "implement")
  const activityToNodeId = useMemo<Record<string, string>>(() => {
    if (!spec?.nodes) {
      return {};
    }
    const map: Record<string, string> = {};
    for (const [nodeId, node] of Object.entries(spec.nodes)) {
      const n = node as { type: string; step?: string };
      if (n.type === 'step' && n.step) {
        map[n.step] = nodeId;
      }
    }
    return map;
  }, [spec]);

  const securityEvents = useMemo<SecurityEvent[]>(
    () =>
      (run?.traces ?? []).flatMap((t: AgentTraceRecord) => {
        const eventType = classifyTraceAsSecurityEvent(t);
        if (!eventType) {
          return [];
        }
        return [
          {
            createdAt: t.createdAt,
            error: t.error,
            eventType,
            externalTicketId: run?.workRequest?.externalTicketId ?? null,
            id: t.id,
            inputJson: t.inputJson,
            nodeId: t.nodeId,
            outputJson: t.outputJson,
            runId: run?.id ?? '',
            startedAt: run?.startedAt ?? '',
            toolName: t.toolName,
            workflowId: run?.workflowId ?? '',
            workRequestId: run?.workRequest?.id ?? null,
          },
        ];
      }),
    [run]
  );

  if (isLoading || !run || !spec) {
    return <LoadingState />;
  }

  const traces = (run as WorkflowRunDetail).traces ?? [];
  const totalTraces = traces.length;

  const TABS: { id: TabId; label: string; count: number | undefined }[] = [
    { count: totalTraces > 0 ? totalTraces : undefined, id: 'traces', label: 'Traces' },
    { count: run.steps.length > 0 ? run.steps.length : undefined, id: 'steps', label: 'Steps' },
    {
      count: securityEvents.length > 0 ? securityEvents.length : undefined,
      id: 'security',
      label: 'Security',
    },
  ];

  const handleNodeClick = (nodeId: string | null) => {
    setSelectedNodeId(nodeId);
  };

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link className="text-ember-400 hover:underline text-sm" href="/templates">
              &larr; Templates
            </Link>
            <h2 className="text-2xl font-bold">Run · {run.templateName}</h2>
            <StatusBadge status={run.status} />
            <span className="text-xs text-paper-400">
              v{run.templateVersion} · {formatRelativeTime(run.startedAt)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {run.status === 'RUNNING' && (
              <Button
                disabled={cancelRun.isPending}
                onClick={() => setShowCancelConfirm(true)}
                size="sm"
                variant="danger"
              >
                {cancelRun.isPending ? 'Cancelling…' : 'Cancel run'}
              </Button>
            )}
            <Link
              className="text-sm text-paper-400 hover:underline"
              href={`/templates/${run.templateId}`}
            >
              View template →
            </Link>
          </div>
        </div>

        {/* Top section: DAG + run metadata */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6 items-start">
          <Card>
            <CardHeader>
              <CardTitle>Execution graph</CardTitle>
            </CardHeader>
            <WorkflowDag
              onSelect={handleNodeClick}
              selectedNodeId={selectedNodeId}
              spec={spec}
              statuses={dagOverlay}
            />
            <div className="flex flex-wrap gap-3 mt-4 text-xs text-paper-400">
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

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Run details</CardTitle>
              </CardHeader>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-paper-400">Started</dt>
                  <dd>{formatDate(run.startedAt)}</dd>
                </div>
                {run.endedAt && (
                  <div className="flex justify-between">
                    <dt className="text-paper-400">Ended</dt>
                    <dd>{formatDate(run.endedAt)}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-paper-400">Workflow ID</dt>
                  <dd className="font-mono text-xs truncate max-w-[160px]">{run.workflowId}</dd>
                </div>
                {totalTraces > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-paper-400">Trace events</dt>
                    <dd className="font-mono text-xs">{totalTraces}</dd>
                  </div>
                )}
                {run.workRequest && (
                  <>
                    <div className="flex justify-between">
                      <dt className="text-paper-400">Ticket</dt>
                      <dd className="font-mono text-xs">{run.workRequest.externalTicketId}</dd>
                    </div>
                    <div className="text-xs text-paper-400 pt-1 border-t border-ink-600">
                      {run.workRequest.description}
                    </div>
                  </>
                )}
              </dl>
            </Card>

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
          </div>
        </div>

        {/* Bottom tabbed panel */}
        <Card className="overflow-hidden p-0">
          {/* Tab bar */}
          <div className="flex border-b border-ink-600 px-2">
            {TABS.map((tab) => (
              <button
                className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  activeTab === tab.id
                    ? 'border-ember-400 text-paper-100'
                    : 'border-transparent text-paper-400 hover:text-paper-200'
                }`}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                type="button"
              >
                {tab.label}
                {tab.count != null && (
                  <span
                    className={`text-[10px] font-mono px-1.5 py-px rounded-full ${
                      activeTab === tab.id
                        ? 'bg-ember-400/20 text-ember-300'
                        : 'bg-ink-600 text-paper-400'
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="min-h-48 max-h-[60vh] overflow-y-auto">
            {activeTab === 'traces' && (
              <TracesTab
                activityToNodeId={activityToNodeId}
                filterNodeId={selectedNodeId}
                onClearFilter={() => setSelectedNodeId(null)}
                traces={traces}
              />
            )}
            {activeTab === 'steps' && <StepsTab onNodeClick={handleNodeClick} steps={run.steps} />}
            {activeTab === 'security' &&
              (securityEvents.length > 0 ? (
                <div className="p-4">
                  <SecurityEventList events={securityEvents} />
                </div>
              ) : (
                <div className="py-12 text-center text-sm text-paper-400">No security events.</div>
              ))}
          </div>
        </Card>
      </div>

      <ConfirmModal
        confirmLabel="Cancel run"
        dangerous
        message="Cancel this run? In-flight steps will be aborted."
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={() => cancelRun.mutate()}
        open={showCancelConfirm}
        title="Cancel run"
      />
    </>
  );
}
