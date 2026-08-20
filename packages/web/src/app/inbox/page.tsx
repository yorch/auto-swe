'use client';

import { useState } from 'react';
import { HumanStepCard } from '@/components/inbox/HumanStepCard';
import { Button } from '@/components/ui/Button';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabBar } from '@/components/ui/TabBar';
import { type InboxFilter, useInbox } from '@/hooks/useInbox';

const TABS: { id: InboxFilter; label: string }[] = [
  { id: 'PENDING', label: 'Pending' },
  { id: 'ALL', label: 'All' },
];

export default function InboxPage() {
  const [filter, setFilter] = useState<InboxFilter>('PENDING');
  const { data: steps, isLoading, refetch, isFetching } = useInbox(filter);

  if (isLoading) {
    return <LoadingState />;
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
