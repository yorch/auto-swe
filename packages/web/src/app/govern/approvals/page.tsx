'use client';

import { useState } from 'react';
import { HumanStepCard } from '@/components/approvals/HumanStepCard';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabBar } from '@/components/ui/TabBar';
import { type ApprovalFilter, useApprovals } from '@/hooks/useApprovals';
import { errMsg } from '@/lib/errors';

const TABS: { id: ApprovalFilter; label: string }[] = [
  { id: 'PENDING', label: 'Pending' },
  { id: 'ALL', label: 'All' },
];

export default function GovernApprovalsPage() {
  const [filter, setFilter] = useState<ApprovalFilter>('PENDING');
  const { data: steps, isLoading, isError, error, refetch, isFetching } = useApprovals(filter);

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
