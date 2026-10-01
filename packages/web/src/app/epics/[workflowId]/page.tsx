'use client';

import Link from 'next/link';
import { use, useRef } from 'react';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
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
    return <EpicNotFound />;
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
    // A load failure is not a missing epic: only an errorless miss reads as "not found".
    if (!error) {
      return <EpicNotFound />;
    }
    return (
      <div className="space-y-8">
        <BackToEpics />
        <Alert>{errMsg(error, `Could not load epic ${workflowId}`)}</Alert>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <BackToEpics />
      <PageHeader
        actions={<StatusBadge status={epic.status} />}
        chapter="§ Requests"
        subtitle="A multi-repository change and the child workflows it fans out to."
        title={epic.externalTicketId}
      />

      <Card>
        <div className="space-y-2">
          <p className="label-mono">
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
        <Table>
          <THead className="bg-ink-800">
            <Th variant="plain">Repository</Th>
            <Th variant="plain">Status</Th>
            <Th variant="plain">Branch</Th>
            <Th variant="plain">Workflow</Th>
          </THead>
          <tbody>
            {epic.children.length === 0 && (
              <TableStatusRow colSpan={4}>
                <EmptyState
                  hint="The Planner agent is still decomposing the epic."
                  title="No child workflows yet."
                />
              </TableStatusRow>
            )}
            {epic.children.map((child) => (
              <TRow hover key={child.temporalWorkflowId ?? child.repoId ?? child.status}>
                <Td className="px-4 py-3 text-paper-100">
                  {child.repoName
                    ? `${child.organizationName}/${child.repoName}`
                    : (child.repoId ?? '—')}
                </Td>
                <Td className="px-4 py-3">
                  <StatusBadge status={child.status} />
                </Td>
                <Td className="px-4 py-3 font-mono text-xs text-paper-400">
                  {child.branch ?? '—'}
                </Td>
                <Td className="px-4 py-3">
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
                </Td>
              </TRow>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function BackToEpics() {
  return (
    <Link className="label-mono hover:text-paper-200" href="/epics">
      ← Epics
    </Link>
  );
}

function EpicNotFound() {
  return (
    <EmptyState
      action={<ButtonLink href="/epics">Back to epics</ButtonLink>}
      title="Epic not found"
    />
  );
}
