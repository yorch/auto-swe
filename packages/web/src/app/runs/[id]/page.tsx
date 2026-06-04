'use client';

import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { use, useMemo, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import { useCancelWorkflowRun, useWorkflowRun } from '@/hooks/useWorkflows';
import { formatDate, formatRelativeTime } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function RunDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const { data: run, isLoading } = useWorkflowRun(id);
  const cancelRun = useCancelWorkflowRun(id);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const dagOverlay = useMemo(() => {
    if (!run?.steps) {
      return undefined;
    }
    const byNodeId: Record<string, { status: string; attempt: number }> = {};
    for (const s of run.steps) {
      // Strip fan-out branch prefix (e.g. "fan[0]/impl") so the parent DAG
      // can show aggregate status. The detail panel still shows per-branch
      // attempts for inspection.
      const baseId = s.nodeId.includes('/') ? (s.nodeId.split('/').pop() ?? s.nodeId) : s.nodeId;
      const existing = byNodeId[baseId];
      if (!existing || s.attempt >= existing.attempt) {
        byNodeId[baseId] = { attempt: s.attempt, status: s.status };
      }
    }
    return { byNodeId };
  }, [run?.steps]);

  if (isLoading || !run) {
    return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading…</div>;
  }

  const spec = run.specSnapshot as WorkflowSpec;
  const nodeRecords =
    selectedNodeId && run.steps
      ? run.steps.filter(
          (s) => s.nodeId === selectedNodeId || s.nodeId.endsWith(`/${selectedNodeId}`)
        )
      : [];

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
