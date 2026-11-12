'use client';

import { use } from 'react';
import { PullRequestReview } from '@/components/review/PullRequestReview';
import { Alert } from '@/components/ui/Alert';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useEntityTitle } from '@/hooks/useEntityTitle';
import { usePullRequestCockpit } from '@/hooks/usePullRequestCockpit';
import { validateRouteParam } from '@/lib/routeParams';
import { visibleText } from '@/lib/visibleText';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function PullRequestReviewPage({ params }: PageProps) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const { data, error, isError, isFetching, isLoading, refetch } = usePullRequestCockpit(id ?? '');
  const pull = data?.pull;
  useEntityTitle(
    pull
      ? `${pull.prNumber !== null ? `#${pull.prNumber} ` : ''}${visibleText(pull.title ?? 'Pull request')}`
      : null
  );
  useDocumentTitle(
    pull
      ? `Review · ${pull.prNumber !== null ? `#${pull.prNumber} ` : ''}${visibleText(pull.title ?? 'Pull request')}`
      : null
  );

  return (
    <div className="space-y-5">
      {id === null ? (
        <Alert variant="error">That is not a pull request address.</Alert>
      ) : (
        <QueryBoundary
          error={error}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="the pull request"
          onRetry={() => void refetch()}
          shape="detail"
        >
          {data ? <PullRequestReview data={data} /> : null}
        </QueryBoundary>
      )}
    </div>
  );
}
