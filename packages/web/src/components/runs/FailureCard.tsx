'use client';

import type { RepoSetupBlockerSummary, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { ExpandablePre } from '@/components/ui/ExpandablePre';
import { Icon } from '@/components/ui/Icon';
import { setupBlockerLabel } from '@/lib/setupBlockers';
import { cn } from '@/lib/utils';

interface FailureCardProps {
  step: WorkflowStepRecord;
  setupBlocker?: RepoSetupBlockerSummary;
  onJumpToFailure?: () => void;
  onReRun?: () => void;
  /** "full" shows suggested fix; "inline" omits it */
  size?: 'full' | 'inline';
}

/**
 * A rough category read from the message text, used only to word the card's title.
 * It is a guess, not a code the platform recorded, so it is never shown as one.
 */
function getErrorCode(step: WorkflowStepRecord): string {
  const error = step.error;
  if (!error) {
    return 'UNKNOWN_ERROR';
  }
  if (error.toLowerCase().includes('timeout') || error.toLowerCase().includes('timed out')) {
    return 'ACTIVITY_TIMEOUT';
  }
  return 'ACTIVITY_FAILED';
}

function getErrorTitle(code: string): string {
  switch (code) {
    case 'ACTIVITY_TIMEOUT':
      return 'Activity task timed out';
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

export function FailureCard({
  step,
  setupBlocker,
  onJumpToFailure,
  onReRun,
  size = 'full',
}: FailureCardProps) {
  const errorCode = getErrorCode(step);
  const errorTitle = setupBlocker ? setupBlockerLabel(setupBlocker.kind) : getErrorTitle(errorCode);
  const suggestedFix = !setupBlocker && size === 'full' ? getSuggestedFix(step, errorCode) : null;
  const diagnostics = step.error ? (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-paper-500">Error message</span>
        <CopyButton value={step.error} />
      </div>
      <ExpandablePre
        className="whitespace-pre-wrap break-words rounded-md border border-ink-500/60 bg-ink-950/50 px-3 py-2 font-mono text-xs leading-relaxed text-paper-300"
        collapsedHeight="9rem"
      >
        {step.error}
      </ExpandablePre>
    </div>
  ) : null;

  return (
    <div
      className={cn(
        'relative rounded-lg border border-danger-400/35 bg-danger-400/[0.06]',
        size === 'full' ? 'p-4' : 'p-3'
      )}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 text-danger-400" name="error" size={18} />
        <div className="min-w-0 flex-1">
          {/* Title, then where it failed and the error class */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4
              className={cn(
                'font-semibold tracking-[-0.01em] text-paper-50',
                size === 'full' ? 'text-lg' : 'text-sm'
              )}
            >
              {errorTitle}
            </h4>
          </div>
          <div className="mt-1 text-xs text-paper-500 max-lg:break-all">
            at step <span className="font-mono text-paper-300">{step.nodeId}</span>
          </div>

          {setupBlocker && (
            <div className="mt-3 space-y-2">
              <p className="text-sm font-semibold text-paper-100">{setupBlocker.remedy}</p>
              {setupBlocker.subject && (
                <p className="break-all font-mono text-sm text-paper-300">{setupBlocker.subject}</p>
              )}
              {setupBlocker.step && (
                <p className="text-xs text-paper-400">Setup step: {setupBlocker.step}</p>
              )}
            </div>
          )}

          {/* Error summary: the raw message, so it reads as output */}
          {setupBlocker ? (
            <details className="mt-3 text-sm text-paper-400">
              <summary className="cursor-pointer">Diagnostics</summary>
              {diagnostics}
            </details>
          ) : (
            diagnostics
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
                <Button className="h-[40px] lg:h-8" onClick={onReRun} size="sm" variant="primary">
                  <Icon name="refresh" size={13} />
                  Re-run
                </Button>
              )}
              {onJumpToFailure && (
                <Button
                  className="h-[40px] lg:h-8"
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
