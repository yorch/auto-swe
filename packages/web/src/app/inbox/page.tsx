'use client';

import { HumanStepCard } from '@/components/inbox/HumanStepCard';
import { Button } from '@/components/ui/Button';
import { LoadingState } from '@/components/ui/LoadingState';
import { useInbox } from '@/hooks/useWorkflows';

export default function InboxPage() {
  const { data: steps, isLoading, refetch, isFetching } = useInbox();

  if (isLoading) {
    return <LoadingState />;
  }

  const count = steps?.length ?? 0;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Inbox</h2>
          <p className="text-sm text-paper-400 mt-1">
            {count === 0
              ? 'No pending actions'
              : `${count} pending action${count !== 1 ? 's' : ''}`}
          </p>
        </div>
        <Button disabled={isFetching} onClick={() => refetch()} size="sm" variant="ghost">
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      {count > 0 && (
        <div className="space-y-3">
          {steps?.map((step) => (
            <HumanStepCard key={step.id} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}
