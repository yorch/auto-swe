'use client';

import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Stat } from '@/components/ui/Stat';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { usePullRequestOutcomes } from '@/hooks/useTemplates';
import type { DateRange } from '@/lib/dateRange';
import { formatDelta } from '@/lib/delta';
import { successTone } from '@/lib/tone';
import { formatDuration, formatPercent } from '@/lib/utils';

/**
 * What became of the pull requests opened in the window: how many merged, how fast, and which
 * repositories they were in. The cohort is judged as of now, so a recent PR that has not been
 * decided yet counts as open rather than as a failure.
 */
export function PullRequestOutcomesCard({
  range,
  windowDays,
}: {
  range: DateRange;
  windowDays: number;
}) {
  const { data, error, isError, isFetching, isLoading, refetch } = usePullRequestOutcomes(range);
  const noun = `vs previous ${windowDays} days`;

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="mb-1 text-lg font-semibold tracking-tight text-paper-50">
        Pull request outcomes
      </h2>
      <p className="mb-4 text-sm text-paper-500">
        Pull requests opened in this window, judged as of now.
      </p>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="pull request outcomes"
        onRetry={() => void refetch()}
        rows={2}
        shape="cards"
      >
        {data && <Outcomes data={data} noun={noun} />}
      </QueryBoundary>
    </Card>
  );
}

function Outcomes({
  data,
  noun,
}: {
  data: NonNullable<ReturnType<typeof usePullRequestOutcomes>['data']>;
  noun: string;
}) {
  const { current, previous } = data;
  const resolved = current.merged + current.closedUnmerged;

  if (current.opened === 0) {
    return <p className="text-sm text-paper-400">No pull requests were opened in this window.</p>;
  }

  return (
    <div className="space-y-6">
      {data.isTruncated && (
        <Alert variant="warning">
          Results capped at the 10,000 most recently opened pull requests. The figures below cover
          only those; older pull requests in this window are omitted.
        </Alert>
      )}
      {!data.previousComplete && (
        <Alert variant="info">
          No comparison with the previous window: the cap on rows read cut into it, so its figures
          would be partial.
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          delta={
            previous
              ? formatDelta(current.mergeRate, previous.mergeRate, {
                  higherIsBetter: true,
                  noun,
                  unit: 'pp',
                })
              : null
          }
          hint={`${resolved} decided: ${current.merged} merged, ${current.closedUnmerged} closed unmerged`}
          label="Merge rate"
          tone={current.mergeRate === null ? 'default' : successTone(current.mergeRate)}
          value={formatPercent(current.mergeRate)}
        />
        <Stat
          delta={
            previous
              ? formatDelta(current.timeToMergeMs.p50, previous.timeToMergeMs.p50, {
                  higherIsBetter: false,
                  noun,
                })
              : null
          }
          hint={`Opened to merged, over ${current.timeToMergeMs.count} merged`}
          label="Time to merge, median"
          value={formatDuration(current.timeToMergeMs.p50)}
        />
        <Stat
          delta={
            previous
              ? formatDelta(current.timeToMergeMs.p95, previous.timeToMergeMs.p95, {
                  higherIsBetter: false,
                  noun,
                })
              : null
          }
          hint="The slowest 1 in 20 took at least this long"
          label="Time to merge, 95th percentile"
          value={formatDuration(current.timeToMergeMs.p95)}
        />
        <Stat
          delta={
            previous
              ? formatDelta(current.opened, previous.opened, { higherIsBetter: null, noun })
              : null
          }
          hint={`${current.open} still open${current.draftCount > 0 ? `, ${current.draftCount} draft` : ''}`}
          label="Opened"
          value={current.opened}
        />
      </div>

      {data.byRepository.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-paper-400">
            Top repositories by PRs opened
          </h3>
          <div className="-mx-4">
            <Table className="max-sm:px-4" stacked>
              <THead>
                <Th className="px-4" variant="compact">
                  Repository
                </Th>
                <Th align="right" className="px-4" variant="compact">
                  Opened
                </Th>
                <Th align="right" className="px-4" variant="compact">
                  Merged
                </Th>
                <Th align="right" className="px-4" variant="compact">
                  Closed unmerged
                </Th>
                <Th align="right" className="px-4" variant="compact">
                  Merge rate
                </Th>
              </THead>
              <tbody>
                {data.byRepository.map(({ repository, summary }) => (
                  <TRow key={repository.id}>
                    <Td className="px-4 py-2.5 font-medium text-paper-100" primary>
                      {repository.org}/{repository.name}
                    </Td>
                    <Td className="px-4 py-2 text-right tabular-nums" label="Opened">
                      {summary.opened}
                    </Td>
                    <Td className="px-4 py-2 text-right tabular-nums" label="Merged">
                      {summary.merged}
                    </Td>
                    <Td className="px-4 py-2 text-right tabular-nums" label="Closed unmerged">
                      {summary.closedUnmerged}
                    </Td>
                    <Td className="px-4 py-2 text-right tabular-nums" label="Merge rate">
                      {formatPercent(summary.mergeRate)}
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
