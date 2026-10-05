'use client';

import type { WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { cn } from '@/lib/utils';

interface FailureCardProps {
  step: WorkflowStepRecord;
  onJumpToFailure?: () => void;
  onReRun?: () => void;
  /** "full" shows suggested fix; "inline" omits it */
  size?: 'full' | 'inline';
}

function getErrorCode(error: string | null | undefined): string {
  if (!error) {
    return 'UNKNOWN_ERROR';
  }
  if (error.toLowerCase().includes('timeout') || error.toLowerCase().includes('timed out')) {
    return 'ACTIVITY_TIMEOUT';
  }
  if (error.toLowerCase().includes('cancel')) {
    return 'CANCELLED';
  }
  return 'ACTIVITY_FAILED';
}

function getErrorTitle(code: string): string {
  switch (code) {
    case 'ACTIVITY_TIMEOUT':
      return 'Activity task timed out';
    case 'CANCELLED':
      return 'Activity was cancelled';
    default:
      return 'Activity failed';
  }
}

function getSuggestedFix(step: WorkflowStepRecord, code: string): string | null {
  if (code === 'ACTIVITY_TIMEOUT') {
    return `The ${step.nodeId} step exceeded its time limit. Consider increasing the timeout or optimising the command that timed out.`;
  }
  return null;
}

export function FailureCard({ step, onJumpToFailure, onReRun, size = 'full' }: FailureCardProps) {
  const errorCode = getErrorCode(step.error);
  const errorTitle = getErrorTitle(errorCode);
  const suggestedFix = size === 'full' ? getSuggestedFix(step, errorCode) : null;

  return (
    <div
      className={cn(
        'relative rounded border border-brick-400/40 bg-brick-400/10',
        size === 'full' ? 'p-4' : 'p-3'
      )}
    >
      {/* Header row */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <StatusBadge status="FAILED" />
        <span className="font-mono text-[10px] tracking-[0.1em] text-brick-400">{errorCode}</span>
      </div>

      {/* Serif title */}
      <h4
        className={cn(
          'mb-1 font-display font-medium tracking-[-0.01em] text-paper-100',
          size === 'full' ? 'text-base' : 'text-sm'
        )}
      >
        {errorTitle}
      </h4>

      {/* Mono locator */}
      <div className="mb-2 break-all font-mono text-[10px] tracking-[0.08em] text-brick-400">
        at {step.nodeId}
      </div>

      {/* Error summary */}
      {step.error && (
        <p className="mb-3 break-words text-paper-400 text-[12px] leading-relaxed">
          {step.error.length > 200 ? `${step.error.slice(0, 200)}…` : step.error}
        </p>
      )}

      {/* Suggested fix (full size only) */}
      {suggestedFix && (
        <Alert className="mb-3" title="Suggested fix" variant="warning">
          {suggestedFix}
        </Alert>
      )}

      {/* Actions */}
      {(onJumpToFailure || onReRun) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {onJumpToFailure && (
            <Button className="h-[40px] lg:h-7" onClick={onJumpToFailure} size="sm" variant="ghost">
              ↳ Jump to failure
            </Button>
          )}
          {onReRun && (
            <Button className="h-[40px] lg:h-7" onClick={onReRun} size="sm" variant="primary">
              Re-run
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
