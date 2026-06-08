'use client';

import { HumanStepCard } from '@/components/inbox/HumanStepCard';
import { LoadingState } from '@/components/ui/LoadingState';
import { useInbox } from '@/hooks/useWorkflows';

export default function InboxPage() {
  const { data: steps, isLoading } = useInbox();

  if (isLoading) {
    return <LoadingState />;
  }

  if (!steps?.length) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Inbox</h2>
        <p className="text-sm text-paper-400">No pending actions.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <h2 className="text-2xl font-bold">Inbox</h2>
      <div className="space-y-3">
        {steps.map((step) => (
          <HumanStepCard key={step.id} step={step} />
        ))}
      </div>
    </div>
  );
}
