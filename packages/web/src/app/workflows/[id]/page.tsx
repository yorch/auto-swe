'use client';

import { pullRequestUrl } from '@auto-swe/shared/lib/pullRequest';
import { useRouter } from 'next/navigation';
import { use, useEffect } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
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
      bordered
      hint="It may have been removed, or the link may be wrong."
      icon="inbox"
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
    <div className="space-y-6">
      <ButtonLink className="-ml-3" href="/workflows" size="sm" variant="ghost">
        <Icon name="arrowLeft" size={14} />
        Requests
      </ButtonLink>
      <PageHeader
        actions={
          <>
            {temporalUrl && (
              <ButtonLink href={temporalUrl} rel="noopener noreferrer" target="_blank">
                Open in Temporal
                <Icon name="external" size={13} />
              </ButtonLink>
            )}
            {prUrl && (
              <ButtonLink href={prUrl} rel="noopener noreferrer" target="_blank" variant="primary">
                View pull request
                <Icon name="external" size={13} />
              </ButtonLink>
            )}
          </>
        }
        subtitle="The request this workflow came from is no longer available, so only its own details are shown."
        title={repo ? `${repo.organizationName}/${repo.repoName}` : 'Workflow'}
      />
      <Card className="max-w-3xl">
        <dl className="grid gap-5 text-sm sm:grid-cols-3">
          <div>
            <dt className="label-mono">Status</dt>
            <dd className="mt-1.5">
              <StatusBadge status={workflow.currentStatus} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="label-mono">Branch</dt>
            <dd className="mt-1.5 break-all font-mono text-[13px] text-paper-200">
              {workflow.assignedBranch}
            </dd>
          </div>
          <div>
            <dt className="label-mono">Cost so far</dt>
            <dd className="tabular mt-1.5 text-paper-200">{formatCost(workflow.costUsdAccrued)}</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
