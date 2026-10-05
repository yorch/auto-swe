'use client';

import type { WorkflowRunDetail, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { HumanStepCard } from '@/components/approvals/HumanStepCard';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import type { useApprovals } from '@/hooks/useApprovals';
import { classifyAgentRunFailure } from '@/lib/agentRun';
import { AgentRunFailureNote } from './AgentRunOutcomeCard';
import { FailureCard } from './FailureCard';
import { RunOutcomeCard } from './RunOutcomeCard';

type ApprovalSteps = NonNullable<ReturnType<typeof useApprovals>['data']>;

export interface RunSummaryProps {
  run: WorkflowRunDetail;
  failedStep: WorkflowStepRecord | null;
  pendingSteps: ApprovalSteps;
  /** Steps already answered, shown with who decided and what they said. */
  answeredSteps?: ApprovalSteps;
  /**
   * `compact` is the request panel: it also states how an attempt ended and keeps the recorded
   * output one click away. `full` is the strip above a run's layout: the result and failure fold
   * away on a phone, and the failure note names an agent run's cause.
   */
  variant: 'compact' | 'full';
  onJumpToFailure?: () => void;
  onReRun?: () => void;
}

export function hasRunResult(result: unknown): boolean {
  return result != null && typeof result === 'object' && Object.keys(result as object).length > 0;
}

/**
 * What needs a person, or what came out of a run, in one order everywhere: pending approvals,
 * the answers already given, the result, then the failure. The request panel and the run page
 * both render it, so a card's props change in one place.
 */
export function RunSummary({
  run,
  failedStep,
  pendingSteps,
  answeredSteps = [],
  variant,
  onJumpToFailure,
  onReRun,
}: RunSummaryProps) {
  const full = variant === 'full';
  // Phones have little height to spare: the result and failure fold away, approvals never do.
  const [folded, setFolded] = useState(false);
  const isAgentRun = run.isAgentRun === true;
  const agentFailure = full && isAgentRun ? classifyAgentRunFailure(failedStep?.error) : null;
  const hasResult = hasRunResult(run.result);
  const ended = run.status === 'FAILED' || run.status === 'TIMED_OUT';
  const hasFailure = failedStep != null || (!full && ended);

  const hasContent =
    pendingSteps.length > 0 ||
    answeredSteps.length > 0 ||
    hasResult ||
    hasFailure ||
    (!full && (run.result != null || run.status === 'SUCCESS'));
  if (!hasContent) {
    return null;
  }

  const foldClass = full && folded ? 'max-md:hidden' : undefined;
  return (
    <div className="space-y-5">
      {pendingSteps.length > 0 && (
        <section aria-label="Needs a response" className="space-y-3">
          <h3 className="font-semibold">Needs a response</h3>
          {pendingSteps.map((step) => (
            <HumanStepCard key={step.id} showRunLink={false} step={step} />
          ))}
        </section>
      )}
      {answeredSteps.length > 0 && (
        <section aria-label="Approver responses" className="space-y-3">
          <h3 className="font-semibold">Responses</h3>
          {answeredSteps.map((step) => (
            <HumanStepCard key={step.id} showRunLink={false} step={step} />
          ))}
        </section>
      )}
      {full && (hasResult || failedStep) && (
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
      {!full && run.status === 'SUCCESS' && (
        <Alert variant="success">
          Execution finished. Review the output before accepting the work.
        </Alert>
      )}
      {(full ? hasResult : true) && (
        <div className={foldClass}>
          <RunOutcomeCard
            isAgentRun={isAgentRun}
            result={run.result}
            templateName={run.templateName ?? ''}
          />
        </div>
      )}
      {!full && run.result != null && (
        <details className="rounded-lg border border-ink-400 p-4">
          <summary className="cursor-pointer text-sm font-semibold">Recorded output</summary>
          <pre className="mt-3 whitespace-pre-wrap break-words text-xs text-paper-400">
            {typeof run.result === 'string' ? run.result : JSON.stringify(run.result, null, 2)}
          </pre>
        </details>
      )}
      {!full && run.status === 'SUCCESS' && run.result == null && (
        <p className="text-sm text-paper-400">No result was recorded for this attempt.</p>
      )}
      {hasFailure && (
        <div className={foldClass}>
          {agentFailure && (
            <div className="mb-2">
              <AgentRunFailureNote failure={agentFailure} />
            </div>
          )}
          {failedStep ? (
            <FailureCard
              onJumpToFailure={onJumpToFailure}
              onReRun={onReRun}
              size="full"
              step={failedStep}
            />
          ) : (
            <Alert>
              The attempt {run.status === 'TIMED_OUT' ? 'timed out' : 'failed'}. Open the technical
              details for more information.
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}
