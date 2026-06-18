'use client';

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useRespondToHumanStep } from '@/hooks/useWorkflows';
import { formatRelativeTime } from '@/lib/utils';

const KIND_LABEL: Record<string, string> = {
  APPROVAL: 'Approval',
  DECISION: 'Decision',
  INPUT: 'Input',
  REVIEW: 'Review',
};

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

export interface HumanStepCardProps {
  step: HumanStepSummary;
  showRunLink?: boolean;
}

export function HumanStepCard({ step, showRunLink = true }: HumanStepCardProps) {
  const respond = useRespondToHumanStep();
  const [expanded, setExpanded] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({});
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [reviewText, setReviewText] = useState(() => contextToString(step.context));
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
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

  function validateInputFields(): boolean {
    const fields = step.fields as Array<{
      key: string;
      label: string;
      type: string;
      required?: boolean;
    }> | null;
    if (!fields) {
      return true;
    }
    const errors: Record<string, string> = {};
    for (const field of fields) {
      if (field.required) {
        const val = inputValues[field.key];
        if (val === undefined || val === '' || val === null) {
          errors[field.key] = 'Required';
        }
      }
    }
    setInputErrors(errors);
    return Object.keys(errors).length === 0;
  }

  const contextStr = contextToString(step.context);
  const hasContext = contextStr.length > 0;

  return (
    <>
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
              <span>{formatRelativeTime(step.requestedAt)}</span>
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
          <Button onClick={toggleExpanded} size="sm" variant="ghost">
            {expanded ? 'Cancel' : 'Respond'}
          </Button>
        </div>

        {expanded && (
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
                  <pre className="mt-2 text-xs font-mono bg-ink-700 rounded p-3 overflow-auto max-h-64 text-paper-300 whitespace-pre-wrap break-words">
                    {contextStr}
                  </pre>
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
                  onClick={() => setShowRejectConfirm(true)}
                  size="sm"
                  variant="danger"
                >
                  Reject
                </Button>
              </div>
            )}

            {step.kind === 'DECISION' && (
              <div className="flex flex-wrap gap-2">
                {(step.options as Array<{ label: string; value: string }> | null)?.map((opt) => (
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

            {step.kind === 'INPUT' && (
              <div className="space-y-2">
                {(
                  step.fields as Array<{
                    key: string;
                    label: string;
                    type: string;
                    required?: boolean;
                    options?: string[];
                  }> | null
                )?.map((field) => (
                  <div className="space-y-0.5" key={field.key}>
                    {/* biome-ignore lint/a11y/noLabelWithoutControl: label wraps a conditional input/select/checkbox — biome can't statically trace through the ternary */}
                    <label className="block">
                      <span className="text-xs font-medium block">
                        {field.label}
                        {field.required && <span className="text-brick-400 ml-0.5">*</span>}
                      </span>
                      {field.type === 'boolean' ? (
                        <input
                          checked={Boolean(inputValues[field.key])}
                          className="mt-1"
                          onChange={(e) => {
                            setInputValues((p) => ({ ...p, [field.key]: e.target.checked }));
                            setInputErrors((p) => ({ ...p, [field.key]: '' }));
                          }}
                          type="checkbox"
                        />
                      ) : field.type === 'select' ? (
                        <Select
                          onChange={(e) => {
                            setInputValues((p) => ({ ...p, [field.key]: e.target.value }));
                            setInputErrors((p) => ({ ...p, [field.key]: '' }));
                          }}
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
                          className="w-full text-sm border border-ink-600 rounded px-2 py-1 font-mono mt-0.5"
                          onChange={(e) => {
                            const raw = e.target.value;
                            setInputValues((p) => ({
                              ...p,
                              [field.key]:
                                field.type === 'number' ? (raw === '' ? null : Number(raw)) : raw,
                            }));
                            setInputErrors((p) => ({ ...p, [field.key]: '' }));
                          }}
                          type={field.type === 'number' ? 'number' : 'text'}
                          value={
                            field.type === 'number'
                              ? inputValues[field.key] == null
                                ? ''
                                : String(inputValues[field.key])
                              : String(inputValues[field.key] ?? '')
                          }
                        />
                      )}
                    </label>
                    {inputErrors[field.key] && (
                      <p className="text-xs text-brick-400">{inputErrors[field.key]}</p>
                    )}
                  </div>
                ))}
                <Button
                  disabled={respond.isPending}
                  onClick={() => {
                    if (!validateInputFields()) {
                      return;
                    }
                    const fields = step.fields as Array<{ key: string; type: string }> | null;
                    const value = Object.fromEntries(
                      (fields ?? []).map((f) => [
                        f.key,
                        f.type === 'number'
                          ? (inputValues[f.key] ?? null)
                          : (inputValues[f.key] ?? ''),
                      ])
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
              <div className="space-y-2">
                <Textarea
                  onChange={(e) => setReviewText(e.target.value)}
                  rows={8}
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
            )}
          </div>
        )}
      </div>

      <ConfirmModal
        confirmLabel="Reject"
        dangerous
        message="This will permanently reject the pending step and cannot be undone."
        onClose={() => setShowRejectConfirm(false)}
        onConfirm={() => handleRespond('reject')}
        open={showRejectConfirm}
        title={`Reject: ${step.title}`}
      />
    </>
  );
}
