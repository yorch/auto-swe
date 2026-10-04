'use client';

import { useRouter } from 'next/navigation';
import { use, useEffect } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useWorkflow } from '@/hooks/useRuns';
import { requestHref } from '@/lib/requestDisplay';
import { validateRouteParam } from '@/lib/routeParams';

/**
 * A workflow's detail now lives in the request panel. This address is kept for
 * old links: it resolves the workflow's request and forwards to it.
 */
export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const router = useRouter();
  const { data: workflow, error, isError, isLoading, refetch } = useWorkflow(id ?? '');
  const requestId = workflow?.workRequest?.id;

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
        isLoading={isLoading}
        label="request"
        onRetry={() => void refetch()}
      />
    );
  }
  return requestId ? null : notFound;
}
