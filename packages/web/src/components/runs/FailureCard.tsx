'use client';

import type { WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';

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
      className="relative"
      style={{
        background: 'oklch(0.64 0.17 28 / 0.07)',
        border: '1px solid oklch(0.64 0.17 28 / 0.38)',
        borderRadius: '4px',
        padding: size === 'full' ? '16px' : '12px',
      }}
    >
      {/* Header row */}
      <div className="flex items-center gap-2 mb-2">
        <StatusBadge status="FAILED" />
        <span
          className="text-brick-400"
          style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: '0.1em' }}
        >
          {errorCode}
        </span>
      </div>

      {/* Serif title */}
      <h4
        className="text-paper-100 mb-1"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: size === 'full' ? '16px' : '14px',
          fontWeight: 500,
          letterSpacing: '-0.01em',
        }}
      >
        {errorTitle}
      </h4>

      {/* Mono locator */}
      <div
        className="text-brick-400 mb-2"
        style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: '0.08em' }}
      >
        at {step.nodeId}
      </div>

      {/* Error summary */}
      {step.error && (
        <p className="text-paper-400 text-[12px] leading-relaxed mb-3">
          {step.error.length > 200 ? `${step.error.slice(0, 200)}…` : step.error}
        </p>
      )}

      {/* Suggested fix (full size only) */}
      {suggestedFix && (
        <div
          className="mb-3 p-2.5"
          style={{
            background: 'oklch(0.78 0.11 80 / 0.07)',
            border: '1px solid oklch(0.78 0.11 80 / 0.25)',
            borderRadius: '3px',
          }}
        >
          <span
            className="text-amber-400"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            ✦ Suggested fix
          </span>
          <p className="text-paper-400 text-[12px] leading-relaxed mt-1">{suggestedFix}</p>
        </div>
      )}

      {/* Actions */}
      {(onJumpToFailure || onReRun) && (
        <div className="flex items-center gap-2 mt-3">
          {onJumpToFailure && (
            <Button onClick={onJumpToFailure} size="sm" variant="ghost">
              ↳ Jump to failure
            </Button>
          )}
          {onReRun && (
            <Button onClick={onReRun} size="sm" variant="primary">
              ↻ Re-run
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
