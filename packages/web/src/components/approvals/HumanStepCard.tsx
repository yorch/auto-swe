'use client';

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useRespondToApproval } from '@/hooks/useApprovals';
import { formatRelativeTime } from '@/lib/utils';
import { DiffRenderer } from './DiffRenderer';

const KIND_LABEL: Record<string, string> = {
  APPROVAL: 'Approval',
  DECISION: 'Decision',
  INPUT: 'Input',
  REVIEW: 'Review',
};

interface DecisionOption {
  label: string;
  value: string;
}

function isDecisionOptions(value: unknown): value is DecisionOption[] {
  return (
    Array.isArray(value) &&
    value.every(
      (o) =>
        typeof o === 'object' &&
        o !== null &&
        typeof (o as Record<string, unknown>).label === 'string' &&
        typeof (o as Record<string, unknown>).value === 'string'
    )
  );
}

interface InputField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
}

function isInputFields(value: unknown): value is InputField[] {
  return (
    Array.isArray(value) &&
    value.every(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        typeof (f as Record<string, unknown>).key === 'string' &&
        typeof (f as Record<string, unknown>).label === 'string' &&
        typeof (f as Record<string, unknown>).type === 'string'
    )
  );
}

const KIND_COLOR: Record<string, string> = {
  APPROVAL: 'bg-amber-400/20 text-amber-400',
  DECISION: 'bg-dust-400/20 text-dust-400',
  INPUT: 'bg-moss-400/20 text-moss-400',
  REVIEW: 'bg-violet-400/20 text-violet-400',
};

function contextToString(context: unknown): string {
  if (context == null) {
    return '';
  }
  if (typeof context === 'string') {
    return context;
  }
  return JSON.stringify(context, null, 2);
}

function getTimestampColor(requestedAt: string): string {
  const ageMs = Date.now() - new Date(requestedAt).getTime();
  if (ageMs > 72 * 3600_000) {
    return 'text-brick-400';
  }
  if (ageMs > 24 * 3600_000) {
    return 'text-amber-400';
  }
  return 'text-paper-500';
}

function formatTimeRemaining(timeoutAt: string): string {
  const msLeft = new Date(timeoutAt).getTime() - Date.now();
  if (msLeft <= 0) {
    return `expired ${formatRelativeTime(timeoutAt)}`;
  }
  if (msLeft < 3_600_000) {
    return `expires in ${Math.ceil(msLeft / 60_000)}m`;
  }
  if (msLeft < 86_400_000) {
    return `expires in ${Math.ceil(msLeft / 3_600_000)}h`;
  }
  return `expires in ${Math.ceil(msLeft / 86_400_000)}d`;
}

function getTimeoutColor(timeoutAt: string): string {
  const msLeft = new Date(timeoutAt).getTime() - Date.now();
  if (msLeft < 2 * 3_600_000) {
    return 'text-brick-400';
  }
  if (msLeft < 8 * 3_600_000) {
    return 'text-amber-400';
  }
  return 'text-paper-500';
}

export interface HumanStepCardProps {
  step: HumanStepSummary;
  showRunLink?: boolean;
}

export function HumanStepCard({ step, showRunLink = true }: HumanStepCardProps) {
  const respond = useRespondToApproval();
  const [expanded, setExpanded] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({});
  const [inputError, setInputError] = useState<string | null>(null);
  const [reviewText, setReviewText] = useState('');
  // Guard against double-submit: isPending from TanStack Query updates asynchronously
  // (after the next render), so a rapid second click reaches this handler before
  // respond.isPending flips to true in the component's closure.
  const inFlight = useRef(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  function toggleExpanded() {
    if (!expanded) {
      // Clear stale error state when re-opening after a failed submission.
      respond.reset();
    }
    setExpanded((v) => !v);
  }

  function handleRespond(action: string, value?: unknown) {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setPendingAction(action === 'select' ? String(value) : action);
    respond.mutate(
      { action, id: step.id, value },
      {
        onSettled: () => {
          inFlight.current = false;
          setPendingAction(null);
        },
        onSuccess: () => setExpanded(false),
      }
    );
  }

  const contextStr = contextToString(step.context);
  const hasContext = contextStr.length > 0;

  return (
    <div className="border border-ink-600 rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded shrink-0 ${KIND_COLOR[step.kind] ?? 'bg-ink-600 text-paper-400'}`}
        >
          {KIND_LABEL[step.kind] ?? step.kind}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{step.title}</div>
          {step.description && (
            <div className="text-xs text-paper-400 mt-0.5">{step.description}</div>
          )}
          <div className="flex flex-wrap items-center gap-x-2 mt-1 text-xs text-paper-500">
            <span className={getTimestampColor(step.requestedAt)}>
              {formatRelativeTime(step.requestedAt)}
            </span>
            {step.status === 'PENDING' && step.timeoutAt && (
              <>
                <span>·</span>
                <span className={getTimeoutColor(String(step.timeoutAt))}>
                  {formatTimeRemaining(String(step.timeoutAt))}
                </span>
              </>
            )}
            {step.kind === 'APPROVAL' && step.requiredApprovers && step.requiredApprovers > 1 && (
              <>
                <span>·</span>
                <span className="text-paper-400">
                  {step.currentApprovers ?? 0} / {step.requiredApprovers} approvals
                </span>
              </>
            )}
            {showRunLink && (
              <>
                <span>·</span>
                {step.run.workRequest?.externalTicketId && (
                  <>
                    <span className="font-mono">{step.run.workRequest.externalTicketId}</span>
                    <span>·</span>
                  </>
                )}
                <Link
                  className="underline text-paper-400 hover:text-paper-200"
                  href={`/runs/${step.run.id}`}
                >
                  View run
                </Link>
              </>
            )}
          </div>
        </div>
        {step.status === 'PENDING' && (
          <Button onClick={toggleExpanded} size="sm" variant="ghost">
            {expanded ? 'Cancel' : 'Respond'}
          </Button>
        )}
        {step.status !== 'PENDING' && (
          <span
            className={`text-[10px] font-mono uppercase tracking-wider shrink-0 ${
              step.status === 'RESOLVED'
                ? 'text-moss-400'
                : step.status === 'TIMED_OUT'
                  ? 'text-paper-500'
                  : 'text-brick-400'
            }`}
          >
            {step.status.replace(/_/g, ' ').toLowerCase()}
          </span>
        )}
      </div>

      {expanded && step.status === 'PENDING' && (
        <div className="border-t border-ink-600 pt-3 space-y-3">
          {respond.isError && (
            <Alert variant="error">
              {respond.error?.message ?? 'Submission failed. Please try again.'}
            </Alert>
          )}

          {/* Context panel for APPROVAL / DECISION */}
          {(step.kind === 'APPROVAL' || step.kind === 'DECISION') && hasContext && (
            <div>
              <button
                className="text-xs text-paper-400 hover:text-paper-200 underline underline-offset-2"
                onClick={() => setShowContext((v) => !v)}
                type="button"
              >
                {showContext ? 'Hide context' : 'Show context'}
              </button>
              {showContext && (
                <div className="mt-2 bg-ink-700 rounded p-3 overflow-auto max-h-64">
                  <DiffRenderer content={contextStr} />
                </div>
              )}
            </div>
          )}

          {step.kind === 'APPROVAL' && (
            <div className="flex gap-2">
              <Button
                disabled={respond.isPending}
                onClick={() => handleRespond('approve')}
                size="sm"
                variant="primary"
              >
                {pendingAction === 'approve' ? 'Submitting…' : 'Approve'}
              </Button>
              <Button
                disabled={respond.isPending}
                onClick={() => handleRespond('reject')}
                size="sm"
                variant="danger"
              >
                Reject
              </Button>
            </div>
          )}

          {step.kind === 'DECISION' && isDecisionOptions(step.options) && (
            <div className="flex flex-wrap gap-2">
              {step.options.map((opt) => (
                <Button
                  disabled={respond.isPending}
                  key={opt.value}
                  onClick={() => handleRespond('select', opt.value)}
                  size="sm"
                  variant="secondary"
                >
                  {respond.isPending && pendingAction === opt.value ? 'Submitting…' : opt.label}
                </Button>
              ))}
            </div>
          )}

          {step.kind === 'INPUT' && isInputFields(step.fields) && (
            <div className="space-y-2">
              {inputError && (
                <Alert className="text-xs" variant="error">
                  {inputError}
                </Alert>
              )}
              {step.fields.map((field) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: label wraps a conditional input/select/checkbox — biome can't statically trace through the ternary
                <label className="block space-y-0.5" key={field.key}>
                  <span className="text-xs font-medium block">
                    {field.label}
                    {field.required && <span className="text-brick-400 ml-0.5">*</span>}
                  </span>
                  {field.type === 'boolean' ? (
                    <input
                      checked={Boolean(inputValues[field.key])}
                      onChange={(e) =>
                        setInputValues((p) => ({ ...p, [field.key]: e.target.checked }))
                      }
                      type="checkbox"
                    />
                  ) : field.type === 'select' ? (
                    <Select
                      onChange={(e) =>
                        setInputValues((p) => ({ ...p, [field.key]: e.target.value }))
                      }
                      value={String(inputValues[field.key] ?? '')}
                    >
                      <option value="">—</option>
                      {field.options?.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <input
                      className="w-full text-sm border border-ink-600 rounded px-2 py-1 font-mono"
                      onChange={(e) =>
                        setInputValues((p) => ({
                          ...p,
                          [field.key]:
                            field.type === 'number'
                              ? e.target.value === ''
                                ? ''
                                : Number(e.target.value)
                              : e.target.value,
                        }))
                      }
                      type={field.type === 'number' ? 'number' : 'text'}
                      value={String(inputValues[field.key] ?? '')}
                    />
                  )}
                </label>
              ))}
              <Button
                disabled={respond.isPending}
                onClick={() => {
                  setInputError(null);
                  if (!isInputFields(step.fields)) {
                    return;
                  }
                  const missing = step.fields
                    .filter(
                      (f) => f.required && (inputValues[f.key] === '' || inputValues[f.key] == null)
                    )
                    .map((f) => f.label || f.key);
                  if (missing.length > 0) {
                    setInputError(`Required: ${missing.join(', ')}`);
                    return;
                  }
                  const value = Object.fromEntries(
                    step.fields.map((f) => {
                      const raw = inputValues[f.key];
                      if (f.type === 'number') {
                        const num = typeof raw === 'string' && raw !== '' ? Number(raw) : raw;
                        return [f.key, typeof num === 'number' && !Number.isNaN(num) ? num : null];
                      }
                      return [f.key, raw ?? ''];
                    })
                  );
                  handleRespond('submit', value);
                }}
                size="sm"
                variant="primary"
              >
                {pendingAction === 'submit' ? 'Submitting…' : 'Submit'}
              </Button>
            </div>
          )}

          {step.kind === 'REVIEW' && (
            <div className={hasContext ? 'flex gap-4 min-h-0' : 'space-y-2'}>
              {hasContext && (
                <div className="flex-[3] min-w-0 flex flex-col gap-1">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-paper-500">
                    Context
                  </span>
                  <div className="overflow-auto max-h-72 bg-ink-700 rounded p-3 flex-1">
                    <DiffRenderer content={contextStr} />
                  </div>
                </div>
              )}
              <div className={hasContext ? 'flex-[2] flex flex-col gap-2' : 'space-y-2'}>
                {hasContext && (
                  <span className="text-[10px] font-mono uppercase tracking-wider text-paper-500">
                    Your notes
                  </span>
                )}
                <textarea
                  className="w-full text-sm border border-ink-600 rounded px-2 py-1 font-mono resize-y"
                  onChange={(e) => setReviewText(e.target.value)}
                  placeholder="Add your review notes…"
                  rows={hasContext ? 10 : 8}
                  value={reviewText}
                />
                <Button
                  disabled={respond.isPending}
                  onClick={() => handleRespond('submit', reviewText)}
                  size="sm"
                  variant="primary"
                >
                  {pendingAction === 'submit' ? 'Submitting…' : 'Submit'}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
