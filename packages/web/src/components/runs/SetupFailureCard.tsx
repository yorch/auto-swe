'use client';

import type { ComponentProps } from 'react';
import { useWorkflowSetupBlocker } from '@/hooks/useRepositories';
import { setupBlockerLabel } from '@/lib/setupBlockers';
import { FailureCard } from './FailureCard';

export function SetupFailureCard({
  repositoryId,
  workflowId,
  compact,
  ...props
}: ComponentProps<typeof FailureCard> & {
  repositoryId: string;
  workflowId: string;
  compact: boolean;
}) {
  const blocker = useWorkflowSetupBlocker(repositoryId, workflowId);
  return (
    <>
      {compact && blocker && (
        <p className="mb-2 text-sm font-semibold text-paper-100">
          Blocker: {setupBlockerLabel(blocker.kind)}
        </p>
      )}
      <FailureCard {...props} setupBlocker={blocker} />
    </>
  );
}
