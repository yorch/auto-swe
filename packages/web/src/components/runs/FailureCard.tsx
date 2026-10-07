'use client';

import type { WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
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
        'relative rounded-lg border border-brick-400/35 bg-brick-400/[0.06]',
        size === 'full' ? 'p-4' : 'p-3'
      )}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 text-brick-400" name="error" size={18} />
        <div className="min-w-0 flex-1">
          {/* Title, then where it failed and the error class */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4
              className={cn(
                'font-semibold tracking-[-0.01em] text-paper-50',
                size === 'full' ? 'text-[15px]' : 'text-sm'
              )}
            >
              {errorTitle}
            </h4>
            <Badge className="font-mono" tone="brick" variant="outline">
              {errorCode}
            </Badge>
          </div>
          <div className="mt-1 text-xs text-paper-500 max-lg:break-all">
            at step <span className="font-mono text-paper-300">{step.nodeId}</span>
          </div>

          {/* Error summary: the raw message, so it reads as output */}
          {step.error && (
            <p className="mt-3 break-words rounded-md border border-ink-500/60 bg-ink-950/50 px-3 py-2 font-mono text-xs leading-relaxed text-paper-300">
              {step.error.length > 200 ? `${step.error.slice(0, 200)}…` : step.error}
            </p>
          )}

          {/* Suggested fix (full size only) */}
          {suggestedFix && (
            <Alert className="mt-3" title="Suggested fix" variant="warning">
              {suggestedFix}
            </Alert>
          )}

          {/* Actions */}
          {(onJumpToFailure || onReRun) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {onReRun && (
                <Button className="h-[40px] lg:h-7" onClick={onReRun} size="sm" variant="primary">
                  <Icon name="refresh" size={13} />
                  Re-run
                </Button>
              )}
              {onJumpToFailure && (
                <Button
                  className="h-[40px] lg:h-7"
                  onClick={onJumpToFailure}
                  size="sm"
                  variant="secondary"
                >
                  Jump to failure
                  <Icon name="arrowRight" size={13} />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
