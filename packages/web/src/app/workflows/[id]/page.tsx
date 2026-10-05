'use client';

import { pullRequestUrl } from '@auto-swe/shared/lib/pullRequest';
import { useRouter } from 'next/navigation';
import { use, useEffect } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useWorkflow } from '@/hooks/useRuns';
import { useTemporalWorkflowUrl } from '@/hooks/useTemporalUi';
import { requestHref } from '@/lib/requestDisplay';
import { validateRouteParam } from '@/lib/routeParams';
import { formatCost } from '@/lib/utils';

/**
 * A workflow's detail now lives in the request panel. This address is kept for
 * old links: it resolves the workflow's request and forwards to it.
 */
export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const router = useRouter();
  const { data: workflow, error, isError, isFetching, isLoading, refetch } = useWorkflow(id ?? '');
  const requestId = workflow?.workRequest?.id;
  const temporalUrl = useTemporalWorkflowUrl(workflow?.temporalWorkflowId ?? '');

  useEffect(() => {
    if (requestId) {
      router.replace(requestHref(requestId));
    }
  }, [requestId, router]);

  const notFound = (
    <EmptyState
      action={<ButtonLink href="/workflows">Back to requests</ButtonLink>}
      title="Request not found"
    />
  );

  if (!id) {
    return notFound;
  }
  // Before the not-found branch, so a 403 or 500 is not reported as "not found".
  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="request"
        onRetry={() => void refetch()}
      />
    );
  }
  if (requestId) {
    return null;
  }
  if (!workflow) {
    return notFound;
  }
  // The workflow exists but its work request was removed: say what is left rather
  // than reporting a record that exists as missing.
  const repo = workflow.repository;
  const pr = workflow.pullRequests.find((candidate) => candidate.prNumber !== null);
  const prUrl = repo && pr ? pullRequestUrl(repo, pr.prNumber) : null;
  return (
    <div className="space-y-4">
      <ButtonLink href="/workflows">Back to requests</ButtonLink>
      <Card>
        <h1 className="text-lg font-semibold text-paper-100">
          {repo ? `${repo.organizationName}/${repo.repoName}` : 'Workflow'}
        </h1>
        <p className="mt-1 text-sm text-paper-400">
          The request this workflow came from is no longer available, so only its own details are
          shown.
        </p>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="label-mono">Status</dt>
            <dd>
              <StatusBadge status={workflow.currentStatus} />
            </dd>
          </div>
          <div>
            <dt className="label-mono">Branch</dt>
            <dd className="break-all text-paper-200">{workflow.assignedBranch}</dd>
          </div>
          <div>
            <dt className="label-mono">Cost so far</dt>
            <dd className="text-paper-200">{formatCost(workflow.costUsdAccrued)}</dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          {prUrl && (
            <a
              className="text-ember-400 hover:underline"
              href={prUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              View pull request ↗
            </a>
          )}
          {temporalUrl && (
            <a
              className="text-ember-400 hover:underline"
              href={temporalUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              Open in Temporal ↗
            </a>
          )}
        </div>
      </Card>
    </div>
  );
}
