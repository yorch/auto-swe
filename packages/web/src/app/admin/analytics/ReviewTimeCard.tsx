'use client';

import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Stat } from '@/components/ui/Stat';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { usePullRequestReviewTime } from '@/hooks/useTemplates';
import type { DateRange } from '@/lib/dateRange';
import { formatDuration, formatPercent } from '@/lib/utils';

/**
 * How long reviewers take: the wait for a first human review and the review-to-merge time of
 * the pull requests opened in the window that were ready for review, and the queue waiting on a
 * person now. Only pull requests with an evaluation can be measured.
 */
export function ReviewTimeCard({ range }: { range: DateRange }) {
  const { data, error, isError, isFetching, isLoading, refetch } = usePullRequestReviewTime(range);

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="mb-1 text-lg font-semibold tracking-tight text-paper-50">Review time</h2>
      <p className="mb-4 text-sm text-paper-500">
        How long pull requests opened in this window waited for a person, and how long review took.
      </p>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="review time"
        onRetry={() => void refetch()}
        rows={2}
        shape="cards"
      >
        {data && <ReviewTime data={data} />}
      </QueryBoundary>
    </Card>
  );
}

function ReviewTime({
  data,
}: {
  data: NonNullable<ReturnType<typeof usePullRequestReviewTime>['data']>;
}) {
  const { overall, queue } = data;

  if (overall.pullRequests === 0 && queue.open === 0) {
    return (
      <p className="text-sm text-paper-400">
        No pull requests ready for review were opened in this window.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {data.truncated && (
        <Alert variant="warning">
          A row cap cut into this window&apos;s pull requests or their evaluations, so the figures
          below cover only part of it.
        </Alert>
      )}
      {overall.lowSample && (
        <Alert variant="info">
          Only {overall.reviewed} pull request{overall.reviewed === 1 ? ' has' : 's have'} a human
          review, too few for these figures to be more than anecdote.
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          hint={`90th percentile ${formatDuration(overall.timeToFirstReview.p90)}, over ${overall.timeToFirstReview.count}`}
          label="Time to first review, median"
          value={formatDuration(overall.timeToFirstReview.p50)}
        />
        <Stat
          hint={`90th percentile ${formatDuration(overall.timeToFirstView.p90)}, over ${overall.timeToFirstView.count}`}
          label="Time to first view, median"
          value={formatDuration(overall.timeToFirstView.p50)}
        />
        <Stat
          hint={`90th percentile ${formatDuration(overall.reviewToMerge.p90)}, over ${overall.reviewToMerge.count}`}
          label="Review to merge, median"
          value={formatDuration(overall.reviewToMerge.p50)}
        />
        <Stat
          hint={`${overall.reviewed} reviewed of ${overall.pullRequests}${
            overall.unmeasured > 0 ? `, ${overall.unmeasured} not measurable` : ''
          }`}
          label="Changes requested"
          value={formatPercent(overall.changeRequestRate)}
        />
      </div>

      <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          hint={`${queue.open} open in all`}
          label="Waiting on a person"
          value={queue.needsHuman}
        />
        <Stat
          hint="Of those waiting on a person"
          label="Longest wait"
          value={formatDuration(queue.oldestWaitingMs)}
        />
        <Stat
          hint="Of those waiting on a person"
          label="Median wait"
          value={formatDuration(queue.medianWaitingMs)}
        />
        <Stat
          hint={`Most ${overall.reviewRounds.max}`}
          label="Review rounds, median"
          value={overall.reviewRounds.median ?? '—'}
        />
      </div>
      {queue.truncated && (
        <Alert variant="warning">
          The open queue is cut: more pull requests are open than one read orders, or an evaluation
          read hit its cap. The queue figures cover the oldest.
        </Alert>
      )}

      {data.byRepository.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-paper-400">
            Top repositories by pull requests
          </h3>
          <div className="-mx-4">
            <Table className="max-sm:px-4" stacked>
              <THead>
                <Th className="px-4" variant="compact">
                  Repository
                </Th>
                <Th align="right" className="px-4" variant="compact">
                  Pull requests
                </Th>
                <Th align="right" className="px-4" variant="compact">
                  Median to first review
                </Th>
                <Th align="right" className="px-4" variant="compact">
                  Median review to merge
                </Th>
              </THead>
              <tbody>
                {data.byRepository.map(({ repository, summary }) => (
                  <TRow key={repository.id}>
                    <Td className="px-4 py-2.5 font-medium text-paper-100" primary>
                      {repository.org}/{repository.name}
                    </Td>
                    <Td className="px-4 py-2 text-right tabular-nums" label="Pull requests">
                      {summary.pullRequests}
                    </Td>
                    <Td
                      className="px-4 py-2 text-right tabular-nums"
                      label="Median to first review"
                    >
                      {formatDuration(summary.timeToFirstReview.p50)}
                    </Td>
                    <Td
                      className="px-4 py-2 text-right tabular-nums"
                      label="Median review to merge"
                    >
                      {formatDuration(summary.reviewToMerge.p50)}
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          </div>
        </div>
      )}

      {data.byTeam.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-paper-400">By team</h3>
          <div className="-mx-4">
            <Table className="max-sm:px-4" stacked>
              <THead>
                <Th className="px-4" variant="compact">
                  Team
                </Th>
                <Th align="right" className="px-4" variant="compact">
                  Pull requests
                </Th>
                <Th align="right" className="px-4" variant="compact">
                  Median to first review
                </Th>
                <Th align="right" className="px-4" variant="compact">
                  Median review to merge
                </Th>
              </THead>
              <tbody>
                {data.byTeam.map(({ summary, teamId, teamName }) => (
                  <TRow key={teamId ?? teamName}>
                    <Td className="px-4 py-2.5 font-medium text-paper-100" primary>
                      {teamName}
                    </Td>
                    <Td className="px-4 py-2 text-right tabular-nums" label="Pull requests">
                      {summary.pullRequests}
                    </Td>
                    <Td
                      className="px-4 py-2 text-right tabular-nums"
                      label="Median to first review"
                    >
                      {formatDuration(summary.timeToFirstReview.p50)}
                    </Td>
                    <Td
                      className="px-4 py-2 text-right tabular-nums"
                      label="Median review to merge"
                    >
                      {formatDuration(summary.reviewToMerge.p50)}
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
