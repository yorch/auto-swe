'use client';

import type { WorkflowRunDetail, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { HumanStepCard } from '@/components/approvals/HumanStepCard';
import { Button } from '@/components/ui/Button';
import type { useApprovals } from '@/hooks/useApprovals';
import { classifyAgentRunFailure } from '@/lib/agentRun';
import { AgentRunFailureNote } from './AgentRunOutcomeCard';
import { FailureCard } from './FailureCard';
import { RunOutcomeCard } from './RunOutcomeCard';

interface RunSummaryBandProps {
  run: WorkflowRunDetail;
  failedStep: WorkflowStepRecord | null;
  pendingSteps: NonNullable<ReturnType<typeof useApprovals>['data']>;
  onJumpToFailure?: () => void;
  onReRun?: () => void;
}

/**
 * What needs a person, or what came out of the run, shown above whichever layout is
 * chosen: pending approvals first, then the result or the failure.
 */
export function RunSummaryBand({
  run,
  failedStep,
  pendingSteps,
  onJumpToFailure,
  onReRun,
}: RunSummaryBandProps) {
  // Phones have little height to spare: the result and failure fold away, approvals never do.
  const [folded, setFolded] = useState(false);
  const isAgentRun = run.isAgentRun === true;
  const agentFailure = isAgentRun ? classifyAgentRunFailure(failedStep?.error) : null;
  const hasResult =
    run.result != null &&
    typeof run.result === 'object' &&
    Object.keys(run.result as Record<string, unknown>).length > 0;

  if (pendingSteps.length === 0 && !hasResult && !failedStep) {
    return null;
  }

  return (
    <div className="max-h-[30vh] shrink-0 space-y-3 md:max-h-[45vh] overflow-y-auto border-b border-ink-600/40 bg-ink-900 px-4 py-3 md:px-6">
      {pendingSteps.length > 0 && (
        <section
          aria-label="Waiting for approval"
          className="space-y-3 rounded-md border border-amber-400/20 bg-amber-400/5 p-3"
        >
          {pendingSteps.map((step) => (
            <HumanStepCard key={step.id} showRunLink={false} step={step} />
          ))}
        </section>
      )}
      {(hasResult || failedStep) && (
        <Button
          aria-expanded={!folded}
          className="md:hidden"
          onClick={() => setFolded((value) => !value)}
          size="sm"
          variant="ghost"
        >
          {folded ? (failedStep ? 'Show failure details' : 'Show result') : 'Hide details'}
        </Button>
      )}
      {hasResult && (
        <div className={folded ? 'max-md:hidden' : undefined}>
          <RunOutcomeCard
            isAgentRun={isAgentRun}
            result={run.result}
            templateName={run.templateName ?? ''}
          />
        </div>
      )}
      {failedStep && (
        <div className={folded ? 'max-md:hidden' : undefined}>
          {agentFailure && (
            <div className="mb-2">
              <AgentRunFailureNote failure={agentFailure} />
            </div>
          )}
          <FailureCard
            onJumpToFailure={onJumpToFailure}
            onReRun={onReRun}
            size="full"
            step={failedStep}
          />
        </div>
      )}
    </div>
  );
}
