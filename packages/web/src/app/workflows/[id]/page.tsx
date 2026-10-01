'use client';

import Link from 'next/link';
import { use } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { KeyValueRow } from '@/components/workflow/KeyValueRow';
import { useRunsForWorkRequest, useWorkflow } from '@/hooks/useRuns';
import { useTemporalWorkflowUrl } from '@/hooks/useTemporalUi';
import { validateRouteParam } from '@/lib/routeParams';
import { formatCost, formatDate, formatRelativeTime, formatTokens } from '@/lib/utils';

export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const { data: workflow, error, isError, isLoading } = useWorkflow(id ?? '');
  const temporalUrl = useTemporalWorkflowUrl(workflow?.temporalWorkflowId ?? '');
  const {
    data: runs,
    error: runsError,
    isError: isRunsError,
    isLoading: isRunsLoading,
  } = useRunsForWorkRequest(workflow?.workRequest?.id);

  const notFound = (
    <EmptyState
      action={<ButtonLink href="/workflows">Back to request queue</ButtonLink>}
      title="Workflow not found"
    />
  );

  if (!id) {
    return notFound;
  }
  // Before the not-found branch, so a 403 or 500 is not reported as "not found".
  if (isLoading || isError) {
    return <QueryBoundary error={error} isError={isError} isLoading={isLoading} label="workflow" />;
  }
  if (!workflow) {
    return notFound;
  }

  // githubUrl is the host base (e.g. https://github.com or a GHE URL).
  const repo = workflow.repository;
  const prHref = (prNumber: number | null) =>
    repo && prNumber != null
      ? `${repo.githubUrl ?? 'https://github.com'}/${repo.organizationName}/${repo.repoName}/pull/${prNumber}`
      : null;

  return (
    <div className="space-y-8">
      <Link className="label-mono hover:text-paper-200" href="/workflows">
        ← Request queue
      </Link>
      <PageHeader
        actions={<StatusBadge status={workflow.currentStatus} />}
        chapter="§ Requests"
        subtitle="Branch, pull requests, cost and runs for one workflow."
        title={workflow.repository?.repoName ?? 'Workflow'}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <dl className="space-y-2">
            <KeyValueRow label="Workflow ID">
              {temporalUrl ? (
                <a
                  className="text-ember-400 hover:underline"
                  href={temporalUrl}
                  rel="noreferrer"
                  target="_blank"
                  title="Open in Temporal"
                >
                  {workflow.temporalWorkflowId}
                </a>
              ) : (
                workflow.temporalWorkflowId
              )}
            </KeyValueRow>
            <KeyValueRow label="Branch">{workflow.assignedBranch}</KeyValueRow>
            <KeyValueRow label="Status">
              <StatusBadge status={workflow.currentStatus} />
            </KeyValueRow>
            <KeyValueRow label="Updated">{formatDate(workflow.updatedAt)}</KeyValueRow>
          </dl>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pull Requests</CardTitle>
          </CardHeader>
          {(workflow.pullRequests ?? []).length === 0 ? (
            <EmptyState className="py-4 text-left" title="No PRs yet" />
          ) : (
            <div className="space-y-2">
              {workflow.pullRequests.map((pr) => {
                const href = prHref(pr.prNumber);
                return (
                  <div className="flex items-center justify-between text-sm" key={pr.id}>
                    {href ? (
                      <a
                        className="font-medium text-ember-400 hover:underline"
                        href={href}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        PR #{pr.prNumber} ↗
                      </a>
                    ) : (
                      <span className="font-medium">PR #{pr.prNumber}</span>
                    )}
                    <div className="flex items-center gap-2">
                      <StatusBadge status={pr.ciStatus ?? 'PENDING'} />
                      <span className="text-xs text-paper-400">{pr.status}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Cost &amp; Token Usage</CardTitle>
        </CardHeader>
        <dl className="space-y-2">
          <KeyValueRow label="Budget Tier">{workflow.budgetTier}</KeyValueRow>
          <KeyValueRow label="Cost Accrued">{formatCost(workflow.costUsdAccrued)}</KeyValueRow>
          <KeyValueRow label="Input Tokens">{formatTokens(workflow.tokensInputUsed)}</KeyValueRow>
          <KeyValueRow label="Output Tokens">{formatTokens(workflow.tokensOutputUsed)}</KeyValueRow>
        </dl>
      </Card>

      {workflow.workRequest && (
        <Card>
          <CardHeader>
            <CardTitle>Work Request</CardTitle>
          </CardHeader>
          <p className="text-sm">
            {workflow.workRequest.description || workflow.workRequest.externalTicketId}
          </p>
        </Card>
      )}

      {/* A failed runs query used to hide the card as if there were no runs. */}
      {(isRunsError || (runs ?? []).length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Runs</CardTitle>
          </CardHeader>
          <QueryBoundary
            compact
            error={runsError}
            isError={isRunsError}
            isLoading={isRunsLoading}
            label="runs"
          >
            <div className="space-y-2">
              {(runs ?? []).map((run) => (
                <div className="flex items-center justify-between text-sm" key={run.id}>
                  <Link className="text-ember-400 hover:underline" href={`/runs/${run.id}`}>
                    Run {run.id.slice(0, 8)} (v{run.templateVersion})
                  </Link>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={run.status} />
                    <span className="text-xs text-paper-400">
                      {formatRelativeTime(run.startedAt)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </QueryBoundary>
        </Card>
      )}
    </div>
  );
}
