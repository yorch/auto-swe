'use client';

import { useState } from 'react';
import { HumanStepCard } from '@/components/approvals/HumanStepCard';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
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

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <Button disabled={isFetching} onClick={() => refetch()} size="sm" variant="secondary">
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
        subtitle={
          isLoading || isError
            ? undefined
            : filter === 'PENDING'
              ? count === 0
                ? undefined
                : `${count}${atCap ? '+' : ''} pending action${count !== 1 ? 's' : ''}`
              : atCap
                ? `Showing ${count} steps, the most this list loads. Sort or filter to see others.`
                : `${count} step${count !== 1 ? 's' : ''} total`
        }
        title={navLabel('/govern/approvals')}
      />

      <TabBar
        active={filter}
        idPrefix="approvals"
        onChange={(next) => {
          setFilter(next);
          setPage(0);
        }}
        tabs={TABS}
      />

      <div {...tabPanelProps('approvals', filter)} className="space-y-8">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            aria-label="Sort"
            className="w-40"
            onChange={(v) => {
              setSort(v as ApprovalSort);
              setPage(0);
            }}
            options={SORT_OPTIONS}
            value={sort}
          />

          <Checkbox
            checked={overdueOnly}
            label="Overdue only"
            onChange={(e) => {
              setOverdueOnly(e.target.checked);
              setPage(0);
            }}
          />
        </div>

        <QueryBoundary
          error={error}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="inbox"
          onRetry={() => void refetch()}
        >
          {count > 0 && (
            <div className="space-y-3">
              {visible.map((step) => (
                <HumanStepCard key={step.id} step={step} />
              ))}
              {count > PAGE_SIZE && (
                <Pagination
                  hasNext={current < pageCount - 1}
                  hasPrev={current > 0}
                  onNext={() => setPage(current + 1)}
                  onPrev={() => setPage(current - 1)}
                  rangeEnd={Math.min(count, (current + 1) * PAGE_SIZE)}
                  rangeStart={current * PAGE_SIZE + 1}
                  total={count}
                />
              )}
            </div>
          )}

          {count === 0 && (
            <EmptyState title={filter === 'PENDING' ? 'No pending actions.' : 'No steps found.'} />
          )}
        </QueryBoundary>
      </div>
    </div>
  );
}
