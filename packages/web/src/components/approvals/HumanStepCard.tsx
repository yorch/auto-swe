'use client';

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useRespondToApproval } from '@/hooks/useApprovals';
import { errMsg } from '@/lib/errors';
import { formatDuration, formatRelativeTime } from '@/lib/utils';
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

const KIND_TONE: Record<string, BadgeTone> = {
  APPROVAL: 'amber',
  DECISION: 'dust',
  INPUT: 'moss',
  REVIEW: 'violet',
};

const STATUS_TONE: Record<string, BadgeTone> = {
  RESOLVED: 'moss',
  TIMED_OUT: 'muted',
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
  return `expires in ${formatDuration(msLeft)}`;
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

const ACTION_LABEL: Record<string, string> = {
  approve: 'Approved',
  reject: 'Rejected',
};

/** A reject must carry enough of a reason to be useful to whoever reads it. */
const MIN_REJECT_REASON = 5;

function isExpired(step: HumanStepSummary): boolean {
  return (
    step.status === 'PENDING' &&
    !!step.timeoutAt &&
    new Date(step.timeoutAt).getTime() <= Date.now()
  );
}

/** What approving does, in the words of the person deciding. */
function approveConsequence(step: HumanStepSummary): string {
  const required = step.requiredApprovers ?? 1;
  const current = step.currentApprovers ?? 0;
  if (required > 1 && current + 1 < required) {
    const left = required - current - 1;
    return `This records your approval. ${left} more ${left === 1 ? 'approval is' : 'approvals are'} needed before the run continues.`;
  }
  if (required > 1) {
    return 'This is the final required approval. The run continues to the next step.';
  }
  return 'The run continues to the next step.';
}

export interface HumanStepCardProps {
  step: HumanStepSummary;
  showRunLink?: boolean;
}

export function HumanStepCard({ step, showRunLink = true }: HumanStepCardProps) {
  const respond = useRespondToApproval();
  const [expanded, setExpanded] = useState(false);
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({});
  const [inputError, setInputError] = useState<string | null>(null);
  const [reviewText, setReviewText] = useState('');
  // Guard against double-submit: isPending from TanStack Query updates asynchronously
  // (after the next render), so a rapid second click reaches this handler before
  // respond.isPending flips to true in the component's closure.
  const inFlight = useRef(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'approve' | 'reject' | null>(null);
  const [comment, setComment] = useState('');
  const [dialogError, setDialogError] = useState<string | null>(null);

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

  // Approve and reject go through a dialog that carries the comment, and need a
  // promise to show their pending state and render a failure inline.
  async function handleDialogSubmit(action: 'approve' | 'reject') {
    if (inFlight.current) {
      return;
    }
    const text = comment.trim();
    if (action === 'reject' && text.length < MIN_REJECT_REASON) {
      setDialogError('Say why you are rejecting this so the requester knows what to change.');
      return;
    }
    inFlight.current = true;
    setPendingAction(action);
    setDialogError(null);
    try {
      await respond.mutateAsync({ action, comment: text || undefined, id: step.id });
      setDialog(null);
      setComment('');
      setExpanded(false);
    } catch (err) {
      setDialogError(errMsg(err, 'Submission failed. Please try again.'));
    } finally {
      inFlight.current = false;
      setPendingAction(null);
    }
  }

  function openDialog(next: 'approve' | 'reject') {
    setComment('');
    setDialogError(null);
    setDialog(next);
  }

  const contextStr = contextToString(step.context);
  const hasContext = contextStr.length > 0;
  const expired = isExpired(step);
  const youApproved = step.status === 'PENDING' && step.myResponse === 'approve';
  const canRespond = step.status === 'PENDING' && !expired && !youApproved;
  const responses = step.responses ?? [];
  const requestId = step.run.workRequestId;

  return (
    <Card className="space-y-3 p-4" variant="inset">
      <div className="flex items-start gap-3">
        <Badge
          className="shrink-0 px-2 font-sans text-xs font-medium"
          tone={KIND_TONE[step.kind] ?? 'neutral'}
        >
          {KIND_LABEL[step.kind] ?? step.kind}
        </Badge>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{step.title}</div>
          {step.description && (
            <div className="text-xs text-paper-400 mt-0.5">{step.description}</div>
          )}
          <div className="flex flex-wrap items-center gap-x-2 mt-1 text-xs text-paper-500">
            <span className={getTimestampColor(step.requestedAt)}>
              {formatRelativeTime(step.requestedAt)}
            </span>
            {step.status === 'PENDING' && step.timeoutAt && !expired && (
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
                    {requestId ? (
                      <Link
                        className="font-mono underline text-paper-400 hover:text-paper-200"
                        href={`/workflows?request=${encodeURIComponent(requestId)}`}
                      >
                        {step.run.workRequest.externalTicketId}
                      </Link>
                    ) : (
                      <span className="font-mono">{step.run.workRequest.externalTicketId}</span>
                    )}
                    <span>·</span>
                  </>
                )}
                <Link
                  className="underline text-paper-400 hover:text-paper-200"
                  href={
                    requestId
                      ? `/workflows?request=${encodeURIComponent(requestId)}`
                      : `/runs/${step.run.id}`
                  }
                >
                  View request
                </Link>
                {requestId && (
                  <>
                    <span>·</span>
                    <Link
                      className="underline text-paper-500 hover:text-paper-200"
                      href={`/runs/${step.run.id}`}
                    >
                      Full diagnostics
                    </Link>
                  </>
                )}
              </>
            )}
          </div>
        </div>
        {canRespond && (
          <Button onClick={toggleExpanded} size="sm" variant="ghost">
            {expanded ? 'Collapse' : 'Respond'}
          </Button>
        )}
        {youApproved && (
          <Badge className="shrink-0" tone="moss" uppercase variant="text">
            You approved
          </Badge>
        )}
        {expired && (
          <Badge className="shrink-0" tone="muted" uppercase variant="text">
            Expired
          </Badge>
        )}
        {step.status !== 'PENDING' && (
          <Badge
            className="shrink-0"
            tone={STATUS_TONE[step.status] ?? 'brick'}
            uppercase
            variant="text"
          >
            {step.status.replace(/_/g, ' ').toLowerCase()}
          </Badge>
        )}
      </div>

      {responses.length > 0 && (
        <ul className="space-y-1 border-t border-ink-600 pt-3 text-xs">
          {responses.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: responses are an ordered, append-only list
            <li className="text-paper-300" key={i}>
              <span className="font-medium">
                {r.byName ?? 'Someone'} · {ACTION_LABEL[r.action] ?? r.action}
              </span>
              {r.comment && (
                <p className="mt-0.5 whitespace-pre-wrap text-paper-400">{r.comment}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {expanded && canRespond && (
        <div className="border-t border-ink-600 pt-3 space-y-3">
          {/* A failed approve or reject is already shown inside its dialog. */}
          {respond.isError && !['approve', 'reject'].includes(respond.variables?.action ?? '') && (
            <Alert variant="error">
              {respond.error?.message ?? 'Submission failed. Please try again.'}
            </Alert>
          )}

          {/* Context for APPROVAL / DECISION is what the decision rests on, so it is open. */}
          {(step.kind === 'APPROVAL' || step.kind === 'DECISION') && hasContext && (
            <div className="space-y-1">
              <span className="label-mono">Context</span>
              <DiffRenderer content={contextStr} />
            </div>
          )}

          {step.kind === 'APPROVAL' && (
            <div className="flex gap-2">
              <Button
                disabled={respond.isPending}
                onClick={() => openDialog('approve')}
                size="sm"
                variant="primary"
              >
                Approve
              </Button>
              <Button
                disabled={respond.isPending}
                onClick={() => openDialog('reject')}
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
              {step.fields.map((field) => {
                const fieldId = `human-step-${step.id}-${field.key}`;
                return field.type === 'boolean' ? (
                  <Checkbox
                    checked={Boolean(inputValues[field.key])}
                    key={field.key}
                    label={field.label}
                    marked={field.required}
                    onChange={(e) =>
                      setInputValues((p) => ({ ...p, [field.key]: e.target.checked }))
                    }
                  />
                ) : field.type === 'select' ? (
                  <Select
                    compact
                    id={fieldId}
                    key={field.key}
                    label={field.label}
                    onChange={(v) => setInputValues((p) => ({ ...p, [field.key]: v }))}
                    options={[
                      { label: '—', value: '' },
                      ...(field.options ?? []).map((o) => ({ label: o, value: o })),
                    ]}
                    required={field.required}
                    value={String(inputValues[field.key] ?? '')}
                  />
                ) : (
                  <Input
                    compact
                    id={fieldId}
                    key={field.key}
                    label={field.label}
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
                    required={field.required}
                    type={field.type === 'number' ? 'number' : 'text'}
                    value={String(inputValues[field.key] ?? '')}
                  />
                );
              })}
              <Button
                disabled={respond.isPending}
                onClick={() => {
                  setInputError(null);
                  if (!isInputFields(step.fields)) {
                    return;
                  }
                  const missing = step.fields
                    .filter(
                      (f) =>
                        f.required &&
                        f.type !== 'boolean' &&
                        (inputValues[f.key] === '' || inputValues[f.key] == null)
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
                      // An untouched checkbox is an explicit `false`, not a missing answer.
                      return [f.key, raw ?? (f.type === 'boolean' ? false : '')];
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
            <div className={hasContext ? 'flex flex-col gap-4 min-h-0 md:flex-row' : 'space-y-2'}>
              {hasContext && (
                <div className="flex-[3] min-w-0 flex flex-col gap-1">
                  <span className="label-mono">Context</span>
                  <DiffRenderer content={contextStr} />
                </div>
              )}
              <div className={hasContext ? 'flex-[2] flex flex-col gap-2' : 'space-y-2'}>
                <Textarea
                  aria-label="Review notes"
                  compact
                  id={`human-step-${step.id}-notes`}
                  label={hasContext ? 'Your notes' : undefined}
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

      <Modal
        onClose={() => setDialog(null)}
        open={dialog !== null}
        title={dialog === 'reject' ? `Reject ${step.title}?` : `Approve ${step.title}?`}
      >
        <p className="text-sm text-paper-400">
          {dialog === 'reject'
            ? 'The workflow is told this step was rejected and continues down its rejection path. This cannot be undone.'
            : approveConsequence(step)}
        </p>
        <Textarea
          compact
          id={`human-step-${step.id}-comment`}
          label={dialog === 'reject' ? 'Reason (required)' : 'Comment (optional)'}
          onChange={(e) => setComment(e.target.value)}
          placeholder={
            dialog === 'reject' ? 'What needs to change?' : 'Add a note for the requester…'
          }
          rows={3}
          value={comment}
        />
        {dialogError && <Alert>{dialogError}</Alert>}
        <ModalFooter
          dangerous={dialog === 'reject'}
          disabled={dialog === 'reject' && comment.trim().length < MIN_REJECT_REASON}
          isPending={pendingAction === 'approve' || pendingAction === 'reject'}
          onCancel={() => setDialog(null)}
          onSubmit={() => dialog && handleDialogSubmit(dialog)}
          pendingLabel={dialog === 'reject' ? 'Rejecting…' : 'Approving…'}
          submitLabel={dialog === 'reject' ? 'Reject' : 'Approve'}
        />
      </Modal>
    </Card>
  );
}
