'use client';

import { useState } from 'react';
import { HumanStepCard } from '@/components/approvals/HumanStepCard';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { TabBar } from '@/components/ui/TabBar';
import { type ApprovalFilter, type ApprovalSort, useApprovals } from '@/hooks/useApprovals';
import { errMsg } from '@/lib/errors';

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

  if (isLoading) {
    return <LoadingState />;
  }

  if (isError) {
    return (
      <div className="p-8">
        <Alert>{errMsg(error, 'Failed to load inbox')}</Alert>
      </div>
    );
  }

  const count = steps?.length ?? 0;

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        actions={
          <Button disabled={isFetching} onClick={() => refetch()} size="sm" variant="ghost">
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
        chapter="§ Inbox"
        subtitle={
          filter === 'PENDING'
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

        <label className="flex items-center gap-2 text-sm text-paper-300">
          <input
            checked={overdueOnly}
            className="rounded border-ink-500 bg-ink-700 text-ember-400 focus:ring-ember-400"
            onChange={(e) => setOverdueOnly(e.target.checked)}
            type="checkbox"
          />
          Overdue only
        </label>
      </div>

      {count > 0 && (
        <div className="space-y-3">
          {steps?.map((step) => (
            <HumanStepCard key={step.id} step={step} />
          ))}
        </div>
      )}

      {count === 0 && !isLoading && (
        <p className="text-sm text-paper-400">
          {filter === 'PENDING' ? 'No pending actions.' : 'No steps found.'}
        </p>
      )}
    </div>
  );
}
