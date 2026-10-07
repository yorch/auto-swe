'use client';

import { useState } from 'react';
import { HumanStepCard } from '@/components/approvals/HumanStepCard';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { Toolbar } from '@/components/ui/Toolbar';
import { type ApprovalFilter, type ApprovalSort, useApprovals } from '@/hooks/useApprovals';
import { navLabel } from '@/lib/navigation';

const TABS: { id: ApprovalFilter; label: string }[] = [
  { id: 'PENDING', label: 'Pending' },
  { id: 'ALL', label: 'All' },
];

const SORT_OPTIONS: { label: string; value: ApprovalSort }[] = [
  { label: 'Newest first', value: 'requestedAt:desc' },
  { label: 'Oldest first', value: 'requestedAt:asc' },
  { label: 'Due soon', value: 'timeoutAt:asc' },
  { label: 'Due last', value: 'timeoutAt:desc' },
];

const PAGE_SIZE = 20;

const INTRO =
  'Steps waiting on a person — approvals, decisions, inputs and reviews — with the context to answer them.';
/** The most steps the gateway returns in one list, by tab. */
const SERVER_CAP: Record<ApprovalFilter, number> = { ALL: 200, PENDING: 100 };

export default function GovernApprovalsPage() {
  const [filter, setFilter] = useState<ApprovalFilter>('PENDING');
  const [sort, setSort] = useState<ApprovalSort>('requestedAt:desc');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [page, setPage] = useState(0);

  const {
    data: steps,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useApprovals(filter, sort, overdueOnly);

  const count = steps?.length ?? 0;
  const atCap = count >= SERVER_CAP[filter];
  const pageCount = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const visible = steps?.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE) ?? [];

  const resetPage = () => setPage(0);

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button disabled={isFetching} onClick={() => refetch()} size="sm" variant="secondary">
            <Icon className={isFetching ? 'animate-spin' : undefined} name="refresh" size={13} />
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
        subtitle={
          isLoading || isError
            ? INTRO
            : filter === 'PENDING'
              ? count === 0
                ? INTRO
                : `${count}${atCap ? '+' : ''} pending action${count !== 1 ? 's' : ''}`
              : atCap
                ? `Showing ${count} steps, the most this list loads. Sort or filter to see others.`
                : `${count} step${count !== 1 ? 's' : ''} total`
        }
        title={navLabel('/govern/approvals')}
      />

      <div>
        <TabBar
          active={filter}
          idPrefix="approvals"
          onChange={(next) => {
            setFilter(next);
            resetPage();
          }}
          tabs={TABS}
        />

        <div {...tabPanelProps('approvals', filter)} className="pt-4">
          <Toolbar>
            <Select
              aria-label="Sort"
              className="w-full sm:w-44"
              compact
              onChange={(v) => {
                setSort(v as ApprovalSort);
                resetPage();
              }}
              options={SORT_OPTIONS}
              value={sort}
            />

            <Checkbox
              checked={overdueOnly}
              className="items-center text-[13px]"
              label="Overdue only"
              onChange={(e) => {
                setOverdueOnly(e.target.checked);
                resetPage();
              }}
            />
          </Toolbar>

          <QueryBoundary
            error={error}
            isError={isError}
            isFetching={isFetching}
            isLoading={isLoading}
            label="inbox"
            loading={<ApprovalSkeleton />}
            onRetry={() => void refetch()}
          >
            {count > 0 && (
              <div className="space-y-3">
                {visible.map((step) => (
                  <HumanStepCard key={step.id} step={step} />
                ))}
                {count > PAGE_SIZE && (
                  <div className="pt-2">
                    <Pagination
                      hasNext={current < pageCount - 1}
                      hasPrev={current > 0}
                      onNext={() => setPage(current + 1)}
                      onPrev={() => setPage(current - 1)}
                      rangeEnd={Math.min(count, (current + 1) * PAGE_SIZE)}
                      rangeStart={current * PAGE_SIZE + 1}
                      total={count}
                    />
                  </div>
                )}
              </div>
            )}

            {count === 0 &&
              (overdueOnly ? (
                <EmptyState
                  action={
                    <Button
                      onClick={() => {
                        setOverdueOnly(false);
                        resetPage();
                      }}
                      size="sm"
                    >
                      Show every step
                    </Button>
                  }
                  bordered
                  hint="Nothing has passed its deadline. Clear the filter to see the rest."
                  icon="clock"
                  title="No overdue steps"
                />
              ) : filter === 'PENDING' ? (
                <EmptyState
                  action={
                    <Button
                      onClick={() => {
                        setFilter('ALL');
                        resetPage();
                      }}
                      size="sm"
                    >
                      See answered steps
                    </Button>
                  }
                  bordered
                  hint="When a run reaches an approval, decision, input or review step, it waits here for a person to answer."
                  icon="inbox"
                  title="You're all caught up"
                />
              ) : (
                <EmptyState
                  action={
                    <ButtonLink href="/workflows/library" size="sm">
                      Browse workflows
                    </ButtonLink>
                  }
                  bordered
                  hint="Steps that need a person appear here once a workflow with a human step runs."
                  icon="inbox"
                  title="No human steps yet"
                />
              ))}
          </QueryBoundary>
        </div>
      </div>
    </div>
  );
}

/** The inbox's shape while it loads: a few step cards. */
function ApprovalSkeleton() {
  return (
    <div aria-live="polite" className="space-y-3" role="status">
      <span className="sr-only">Loading…</span>
      {['a', 'b', 'c'].map((key) => (
        <div className="rounded-xl border border-ink-400/40 bg-ink-900/50 p-4" key={key}>
          <div className="flex items-start gap-3">
            <Skeleton className="h-5 w-16" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-7 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
