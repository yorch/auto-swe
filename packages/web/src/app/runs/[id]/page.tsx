'use client';

import type {
  AgentTraceRecord,
  WorkflowRunDetail,
  WorkflowStepRecord,
} from '@auto-swe/shared/types/api';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { use, useMemo, useState } from 'react';
import { HumanStepCard } from '@/components/inbox/HumanStepCard';
import { LayoutToggle } from '@/components/LayoutToggle';
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
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { useCancelWorkflowRun, useInbox, useWorkflowRun } from '@/hooks/useWorkflows';
import { formatDate, formatRelativeTime } from '@/lib/utils';
import { SplitRunPanel } from './SplitRunPanel';
import { TracesTab } from './TracesTab';

interface PageProps {
  params: Promise<{ id: string }>;
}

type TabId = 'traces' | 'steps' | 'security';

// ── Steps tab ─────────────────────────────────────────────────────────────────

function StepsTab({
  activityToNodeId,
  expandedNodeId,
  onToggleExpand,
  steps,
  traces,
}: {
  activityToNodeId: Record<string, string>;
  expandedNodeId: string | null;
  onToggleExpand: (nodeId: string) => void;
  steps: WorkflowStepRecord[];
  traces: AgentTraceRecord[];
}) {
  if (steps.length === 0) {
    return <div className="py-12 text-center text-sm text-paper-400">No steps recorded yet.</div>;
  }

  return (
    <div className="divide-y divide-ink-600/50">
      {steps.map((s) => (
        <div key={s.id}>
          <button
            className="w-full flex items-start gap-3 px-4 py-3 hover:bg-ink-800/40 transition-colors text-left"
            onClick={() => onToggleExpand(s.nodeId)}
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
            <span className="text-[10px] text-paper-400 shrink-0 pt-1">
              {expandedNodeId === s.nodeId ? '▲' : '▶'}
            </span>
          </button>
          {expandedNodeId === s.nodeId && (
            <div className="border-t border-ink-600/50 bg-ink-900/30">
              <TracesTab
                activityToNodeId={activityToNodeId}
                compact
                filterNodeId={s.nodeId}
                onClearFilter={() => {}}
                traces={traces}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RunDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const { data: run, isError, isLoading } = useWorkflowRun(id);
  const cancelRun = useCancelWorkflowRun(id);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('traces');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const { data: inboxSteps } = useInbox();
  const { layout, setLayout } = useUserPreferences();

  const handleToggleExpand = (nodeId: string) =>
    setExpandedNodeId((prev) => (prev === nodeId ? null : nodeId));

  const handleLayoutChange = (newLayout: 'split' | 'inline') => {
    setLayout(newLayout);
    if (newLayout === 'split' && activeTab === 'steps') {
      setActiveTab('traces');
    }
  };

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
    [run?.traces, run?.id, run?.workflowId, run?.workRequest, run?.startedAt]
  );

  if (isLoading) {
    return <LoadingState />;
  }
  // Missing/forbidden run or a run without a spec snapshot: render a real
  // error state instead of spinning forever.
  if (isError || !run || !spec) {
    return <div className="text-center py-12 text-paper-400">Run not found</div>;
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
    if (layout === 'split') {
      setActiveTab('traces');
    } else if (nodeId) {
      setActiveTab('steps');
      setExpandedNodeId(nodeId);
    }
  };

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link className="text-ember-400 hover:underline text-sm" href="/runs">
              &larr; Runs
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
          {/* Tab bar — adapts to layout */}
          <div className="flex items-center border-b border-ink-600 px-2">
            {layout === 'split' ? (
              <>
                <button
                  className="flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 border-ember-400 text-paper-100 -mb-px"
                  onClick={() => setActiveTab('traces')}
                  type="button"
                >
                  Run
                </button>
                {securityEvents.length > 0 && (
                  <button
                    className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                      activeTab === 'security'
                        ? 'border-ember-400 text-paper-100'
                        : 'border-transparent text-paper-400 hover:text-paper-200'
                    }`}
                    onClick={() => setActiveTab('security')}
                    type="button"
                  >
                    Security
                    <span className="text-[10px] font-mono px-1.5 py-px rounded-full bg-ink-600 text-paper-400">
                      {securityEvents.length}
                    </span>
                  </button>
                )}
              </>
            ) : (
              TABS.map((tab) => (
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
              ))
            )}
            <div className="ml-auto pr-2 flex items-center">
              <LayoutToggle onChange={handleLayoutChange} value={layout} />
            </div>
          </div>

          {/* Tab content */}
          {layout === 'split' ? (
            activeTab === 'security' ? (
              <div className="min-h-48 max-h-[60vh] overflow-y-auto p-4">
                <SecurityEventList events={securityEvents} />
              </div>
            ) : (
              <SplitRunPanel
                activityToNodeId={activityToNodeId}
                onSelectNode={setSelectedNodeId}
                selectedNodeId={selectedNodeId}
                steps={run.steps}
                traces={traces}
              />
            )
          ) : (
            <div className="min-h-48 max-h-[60vh] overflow-y-auto">
              {activeTab === 'traces' && (
                <TracesTab
                  activityToNodeId={activityToNodeId}
                  filterNodeId={selectedNodeId}
                  onClearFilter={() => setSelectedNodeId(null)}
                  traces={traces}
                />
              )}
              {activeTab === 'steps' && (
                <StepsTab
                  activityToNodeId={activityToNodeId}
                  expandedNodeId={expandedNodeId}
                  onToggleExpand={handleToggleExpand}
                  steps={run.steps}
                  traces={traces}
                />
              )}
              {activeTab === 'security' &&
                (securityEvents.length > 0 ? (
                  <div className="p-4">
                    <SecurityEventList events={securityEvents} />
                  </div>
                ) : (
                  <div className="py-12 text-center text-sm text-paper-400">
                    No security events.
                  </div>
                ))}
            </div>
          )}
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
