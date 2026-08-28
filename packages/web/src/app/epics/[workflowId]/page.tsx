'use client';

import Link from 'next/link';
import { use, useRef } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useEpic } from '@/hooks/useEpics';
import { errMsg } from '@/lib/errors';
import { validateRouteParam } from '@/lib/routeParams';
import { formatRelativeTime } from '@/lib/utils';

interface PageProps {
  params: Promise<{ workflowId: string }>;
}

/**
 * How long after first render a failing GET /epics/:id is treated as "the epic
 * is still starting" rather than an error. The epic's ActiveWorkflow row only
 * appears after the orchestrator's first state update, so the detail endpoint
 * can briefly 404 right after creation.
 */
const STARTUP_GRACE_MS = 45_000;

export default function EpicDetailPage({ params }: PageProps) {
  const { workflowId: rawWorkflowId } = use(params);
  const workflowId = validateRouteParam(rawWorkflowId);
  const mountedAtRef = useRef(Date.now());
  const { data: epic, isLoading, error } = useEpic(workflowId ?? '');

  if (!workflowId) {
    return (
      <Card>
        <p className="text-sm text-brick-400">Epic not found</p>
      </Card>
    );
  }

  if (isLoading) {
    return <LoadingState message="loading epic…" />;
  }

  if (!epic) {
    // Right after creation the epic row may not exist yet — keep polling
    // quietly (the hook retries + refetches) instead of flashing an error.
    if (Date.now() - mountedAtRef.current < STARTUP_GRACE_MS) {
      return <LoadingState message="epic is starting…" />;
    }
    return (
      <Card>
        <p className="text-sm text-brick-400">{errMsg(error, `Epic ${workflowId} not found`)}</p>
        <p className="mt-2 text-xs text-paper-500">
          <Link className="text-ember-400 hover:underline" href="/epics">
            ← Back to epics
          </Link>
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <>
            <StatusBadge status={epic.status} />
            <Link className="text-sm text-ember-400 hover:underline" href="/epics">
              ← All epics
            </Link>
          </>
        }
        chapter="§ Epics"
        title={epic.externalTicketId}
      />

      <Card>
        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
            {epic.epicWorkflowId}
            {epic.createdAt ? ` · created ${formatRelativeTime(epic.createdAt)}` : ''}
            {epic.requestedBy ? ` · by ${epic.requestedBy.name ?? epic.requestedBy.email}` : ''}
          </p>
          <p className="text-sm text-paper-200">{epic.description || '—'}</p>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        <CardHeader className="px-4 pt-4">
          <CardTitle>Child workflows ({epic.children.length})</CardTitle>
        </CardHeader>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-600 bg-ink-800">
              <th className="text-left px-4 py-3 font-medium">Repository</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Branch</th>
              <th className="text-left px-4 py-3 font-medium">Workflow</th>
            </tr>
          </thead>
          <tbody>
            {epic.children.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-xs text-paper-500" colSpan={4}>
                  No child workflows yet — the Planner agent is still decomposing the epic.
                </td>
              </tr>
            )}
            {epic.children.map((child) => (
              <tr
                className="border-b border-ink-600 hover:bg-ink-800 transition-colors"
                key={child.temporalWorkflowId ?? child.repoId ?? child.status}
              >
                <td className="px-4 py-3 text-paper-100">
                  {child.repoName
                    ? `${child.organizationName}/${child.repoName}`
                    : (child.repoId ?? '—')}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={child.status} />
                </td>
                <td className="px-4 py-3 font-mono text-xs text-paper-400">
                  {child.branch ?? '—'}
                </td>
                <td className="px-4 py-3">
                  {child.workflowId ? (
                    <Link
                      className="text-ember-400 hover:underline font-mono text-xs"
                      href={`/workflows/${child.workflowId}`}
                    >
                      view →
                    </Link>
                  ) : (
                    <span className="font-mono text-xs text-paper-500">not started</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
