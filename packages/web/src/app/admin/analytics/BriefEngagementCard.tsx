'use client';

import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Stat } from '@/components/ui/Stat';
import { MAX_ENGAGEMENT_DAYS, usePrEngagement } from '@/hooks/useWorkViews';
import { formatDuration, formatPercent, plural } from '@/lib/utils';

/**
 * Whether reviewers go where the reviewer brief points: how many evaluated pull requests a person
 * reviewed, how long that took, how often they asked for changes, and which files their inline
 * comments landed on. Counts are approximate: a delivery sent twice counts twice, and a review is
 * counted only against the evaluation of the head it was made on.
 */
export function BriefEngagementCard({ windowDays }: { windowDays: number }) {
  const { data, error, isError, isFetching, isLoading, refetch } = usePrEngagement(windowDays);
  const asked = Math.min(Math.max(Math.trunc(windowDays), 1), MAX_ENGAGEMENT_DAYS);

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="mb-1 text-lg font-semibold tracking-tight text-paper-50">
        Reviewer engagement
      </h2>
      <p className="mb-4 text-sm text-paper-500">
        Whether people review the pull requests the platform evaluates, and where their comments
        land.
      </p>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="reviewer engagement"
        onRetry={() => void refetch()}
        rows={2}
        shape="cards"
      >
        {data && (
          <div className="space-y-5">
            {asked !== Math.trunc(windowDays) && (
              <Alert variant="info">
                Showing the last {plural(asked, 'day')}, the longest window this reads.
              </Alert>
            )}
            {data.capped && (
              <Alert variant="warning">
                The window held more evaluations than one read takes. The figures cover the newest
                ones only.
              </Alert>
            )}
            {data.evaluations === 0 ? (
              <p className="text-sm text-paper-400">
                No pull requests were evaluated in the last {plural(data.windowDays, 'day')}.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-5">
                <Stat
                  hint={`${data.reviewed} of ${plural(data.evaluations, 'evaluation')} reviewed by a person`}
                  label="Reviewed"
                  value={formatPercent(data.reviewed / data.evaluations)}
                />
                <Stat
                  hint={`From the pull request opening to someone opening it on the review page, across ${plural(data.pullRequestsViewed, 'pull request')}`}
                  label="Time to first view, median"
                  value={
                    data.medianMinutesToFirstView === null
                      ? '—'
                      : formatDuration(data.medianMinutesToFirstView * 60_000)
                  }
                />
                <Stat
                  hint="From the evaluation to the first review"
                  label="Time to first review, median"
                  value={
                    data.medianMinutesToFirstReview === null
                      ? '—'
                      : formatDuration(data.medianMinutesToFirstReview * 60_000)
                  }
                />
                <Stat
                  hint="Of the reviewed ones, with at least one review asking for changes"
                  label="Change-request rate"
                  value={formatPercent(data.changeRequestRate)}
                />
                <Stat
                  hint={`${data.comments.flagged} on flagged files, ${data.comments.skimmed} on files marked safe to skim, ${data.comments.elsewhere} elsewhere`}
                  label="Comments on flagged files"
                  value={formatPercent(data.comments.flaggedShare)}
                />
              </div>
            )}
          </div>
        )}
      </QueryBoundary>
    </Card>
  );
}
