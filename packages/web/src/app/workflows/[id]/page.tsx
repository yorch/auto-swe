'use client';

import Link from 'next/link';
import { use } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useRunsForWorkRequest } from '@/hooks/useRuns';
import { useWorkflow } from '@/hooks/useWorkflows';
import { formatCost, formatDate, formatRelativeTime, formatTokens } from '@/lib/utils';

export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: workflow, isLoading } = useWorkflow(id);
  const { data: runs } = useRunsForWorkRequest(workflow?.workRequest?.id);

  if (isLoading) {
    return <LoadingState />;
  }
  if (!workflow) {
    return <div className="text-center py-12 text-paper-400">Workflow not found</div>;
  }

  // githubUrl is the host base (e.g. https://github.com or a GHE URL).
  const repo = workflow.repository;
  const prHref = (prNumber: number | null) =>
    repo && prNumber != null
      ? `${repo.githubUrl ?? 'https://github.com'}/${repo.organizationName}/${repo.repoName}/pull/${prNumber}`
      : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link className="text-ember-400 hover:underline text-sm" href="/workflows">
          &larr; Workflows
        </Link>
        <h2 className="text-2xl font-bold">{workflow.repository?.repoName ?? 'Workflow'}</h2>
        <StatusBadge status={workflow.currentStatus} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-paper-400">Workflow ID</dt>
              <dd className="font-mono text-xs">{workflow.temporalWorkflowId}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-paper-400">Branch</dt>
              <dd>{workflow.assignedBranch}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-paper-400">Status</dt>
              <dd>
                <StatusBadge status={workflow.currentStatus} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-paper-400">Updated</dt>
              <dd>{formatDate(workflow.updatedAt)}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pull Requests</CardTitle>
          </CardHeader>
          {(workflow.pullRequests ?? []).length === 0 ? (
            <p className="text-sm text-paper-400">No PRs yet</p>
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
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-paper-400">Budget Tier</dt>
            <dd className="font-medium">{workflow.budgetTier}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-paper-400">Cost Accrued</dt>
            <dd className="font-medium">{formatCost(workflow.costUsdAccrued)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-paper-400">Input Tokens</dt>
            <dd>{formatTokens(workflow.tokensInputUsed)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-paper-400">Output Tokens</dt>
            <dd>{formatTokens(workflow.tokensOutputUsed)}</dd>
          </div>
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

      {(runs ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Runs</CardTitle>
          </CardHeader>
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
        </Card>
      )}
    </div>
  );
}
