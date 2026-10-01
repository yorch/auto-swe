'use client';

import { useState } from 'react';
import { HumanStepCard } from '@/components/approvals/HumanStepCard';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { TabBar } from '@/components/ui/TabBar';
import { type ApprovalFilter, type ApprovalSort, useApprovals } from '@/hooks/useApprovals';

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

export default function GovernApprovalsPage() {
  const [filter, setFilter] = useState<ApprovalFilter>('PENDING');
  const [sort, setSort] = useState<ApprovalSort>('requestedAt:desc');
  const [overdueOnly, setOverdueOnly] = useState(false);

  const {
    data: steps,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useApprovals(filter, sort, overdueOnly);

  const count = steps?.length ?? 0;

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader
        actions={
          <Button disabled={isFetching} onClick={() => refetch()} size="sm" variant="ghost">
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
        chapter="§ Govern"
        subtitle={
          isLoading || isError
            ? undefined
            : filter === 'PENDING'
              ? count === 0
                ? 'No pending actions'
                : `${count} pending action${count !== 1 ? 's' : ''}`
              : `${count} step${count !== 1 ? 's' : ''} total`
        }
        title="Inbox"
      />

      <TabBar active={filter} onChange={setFilter} tabs={TABS} />

      <div className="flex flex-wrap items-center gap-3">
        <Select
          aria-label="Sort"
          className="w-40"
          onChange={(e) => setSort(e.target.value as ApprovalSort)}
          value={sort}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>

        <Checkbox
          checked={overdueOnly}
          label="Overdue only"
          onChange={(e) => setOverdueOnly(e.target.checked)}
        />
      </div>

      <QueryBoundary error={error} isError={isError} isLoading={isLoading} label="inbox">
        {count > 0 && (
          <div className="space-y-3">
            {steps?.map((step) => (
              <HumanStepCard key={step.id} step={step} />
            ))}
          </div>
        )}

        {count === 0 && (
          <EmptyState title={filter === 'PENDING' ? 'No pending actions.' : 'No steps found.'} />
        )}
      </QueryBoundary>
    </div>
  );
}
