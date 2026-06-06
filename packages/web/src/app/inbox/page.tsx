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
      <div className="p-8">
        <h1 className="text-lg font-semibold mb-2">Inbox</h1>
        <p className="text-sm text-paper-400">No pending actions.</p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-lg font-semibold mb-4">Inbox</h1>
      <div className="space-y-3">
        {steps.map((step) => (
          <HumanStepCard key={step.id} step={step} />
        ))}
      </div>
    </div>
  );
}
