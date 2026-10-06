'use client';

import { use, useRef } from 'react';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { RelativeTime } from '@/components/work/RelativeTime';
import { useEpic } from '@/hooks/useEpics';
import { useRunsForWorkRequest } from '@/hooks/useRuns';
import { epicChildRunCell } from '@/lib/epicChildRun';
import { errMsg } from '@/lib/errors';
import { requestHref } from '@/lib/requestDisplay';
import { validateRouteParam } from '@/lib/routeParams';

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
  // Every child run shares the epic's work request. The child's ActiveWorkflow
  // row is self-registered without a repository, so /workflows/:id cannot show
  // it; its WorkflowRun (keyed by the same Temporal workflow ID) can.
  // 100 is the list endpoint's page cap — far above any realistic repo count.
  const { data: childRuns, isSuccess: childRunsSettled } = useRunsForWorkRequest(
    epic?.workRequestId,
    100
  );
  const runIdByTemporalId = new Map((childRuns ?? []).map((r) => [r.workflowId, r.id]));

  if (!workflowId) {
    return <EpicNotFound />;
  }

  if (isLoading) {
    return <LoadingState message="Loading epic…" />;
  }

  if (!epic) {
    // Right after creation the epic row may not exist yet — keep polling
    // quietly (the hook retries + refetches) instead of flashing an error.
    if (Date.now() - mountedAtRef.current < STARTUP_GRACE_MS) {
      return <LoadingState message="The epic is starting…" />;
    }
    // A load failure is not a missing epic: only an errorless miss reads as "not found".
    if (!error) {
      return <EpicNotFound />;
    }
    return (
      <div className="space-y-6">
        <BackToEpics />
        <Alert>{errMsg(error, `Could not load epic ${workflowId}`)}</Alert>
      </div>
    );
  }

  const done = epic.children.filter((child) => child.status === 'SUCCESS').length;
  return (
    <div className="space-y-6">
      <BackToEpics />
      <PageHeader
        actions={
          epic.workRequestId && (
            <ButtonLink href={requestHref(epic.workRequestId)} variant="secondary">
              View request
            </ButtonLink>
          )
        }
        subtitle="A multi-repository change and the child workflows it fans out to."
        title={epic.externalTicketId}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Brief</CardTitle>
            </CardHeader>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-paper-200">
              {epic.description || <span className="text-paper-500">No description</span>}
            </p>
          </Card>

          <Card className="overflow-hidden p-0">
            <CardHeader className="mb-0 px-5 pt-5 pb-3">
              <CardTitle>Child workflows</CardTitle>
              <span className="tabular text-[13px] text-paper-400">
                {done} of {epic.children.length} finished
              </span>
            </CardHeader>
            <Table stacked>
              <THead>
                <Th variant="plain">Repository</Th>
                <Th variant="plain">Status</Th>
                <Th variant="plain">Branch</Th>
                <Th align="right" variant="plain">
                  <span className="sr-only">Diagnostics</span>
                </Th>
              </THead>
              <tbody>
                {epic.children.length === 0 && (
                  <TableStatusRow colSpan={4}>
                    <EmptyState
                      hint="The planner is still splitting the epic into per-repository work."
                      icon="clock"
                      title="No child workflows yet"
                    />
                  </TableStatusRow>
                )}
                {epic.children.map((child) => (
                  <TRow hover key={child.temporalWorkflowId ?? child.repoId ?? child.status}>
                    <Td className="px-4 py-3 font-medium text-paper-100" primary>
                      {child.repoName
                        ? `${child.organizationName}/${child.repoName}`
                        : (child.repoId ?? '—')}
                    </Td>
                    <Td className="px-4 py-3" label="Status">
                      <StatusBadge status={child.status} />
                    </Td>
                    <Td
                      className="break-all px-4 py-3 font-mono text-xs text-paper-400"
                      label="Branch"
                    >
                      {child.branch ?? '—'}
                    </Td>
                    <Td align="right" className="whitespace-nowrap px-4 py-3">
                      {(() => {
                        const cell = epicChildRunCell(child, runIdByTemporalId, childRunsSettled);
                        if (cell.kind === 'run') {
                          return (
                            <ButtonLink href={`/runs/${cell.runId}`} size="sm" variant="ghost">
                              Diagnostics
                              <Icon name="arrowRight" size={13} />
                            </ButtonLink>
                          );
                        }
                        if (cell.kind === 'no-access') {
                          return (
                            <span
                              className="inline-flex items-center gap-1 text-xs text-paper-500"
                              title="This child's run is not visible to you — it likely belongs to a team you are not a member of."
                            >
                              <Icon name="lock" size={12} />
                              No access
                            </span>
                          );
                        }
                        return (
                          <span className="text-xs text-paper-500">
                            {cell.kind === 'starting' ? 'Starting…' : 'Not started'}
                          </span>
                        );
                      })()}
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>

        <Card className="h-fit p-5" variant="inset">
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="label-mono">Status</dt>
              <dd className="mt-1">
                <StatusBadge status={epic.status} />
              </dd>
            </div>
            {epic.createdAt && (
              <div>
                <dt className="label-mono">Created</dt>
                <dd className="mt-1 text-paper-200">
                  <RelativeTime date={epic.createdAt} />
                </dd>
              </div>
            )}
            {epic.requestedBy && (
              <div>
                <dt className="label-mono">Requested by</dt>
                <dd className="mt-1 break-words text-paper-200">
                  {epic.requestedBy.name ?? epic.requestedBy.email}
                </dd>
              </div>
            )}
            <div>
              <dt className="label-mono">Repositories</dt>
              <dd className="tabular mt-1 text-paper-200">{epic.children.length}</dd>
            </div>
            <div>
              <dt className="label-mono">Epic workflow ID</dt>
              <dd className="mt-1 flex items-start gap-1">
                <span className="min-w-0 break-all font-mono text-xs text-paper-300">
                  {epic.epicWorkflowId}
                </span>
                <CopyButton value={epic.epicWorkflowId} />
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}

function BackToEpics() {
  return (
    <ButtonLink className="-ml-3" href="/epics" size="sm" variant="ghost">
      <Icon name="arrowLeft" size={14} />
      Epics
    </ButtonLink>
  );
}

function EpicNotFound() {
  return (
    <EmptyState
      action={<ButtonLink href="/epics">Back to epics</ButtonLink>}
      bordered
      hint="It may have been removed, or the link may be wrong."
      icon="epics"
      title="Epic not found"
    />
  );
}
