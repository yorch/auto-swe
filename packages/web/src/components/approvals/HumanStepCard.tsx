'use client';

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useRespondToApproval } from '@/hooks/useApprovals';
import { errMsg } from '@/lib/errors';
import { requestHref } from '@/lib/requestDisplay';
import { cn, FOCUS_RING, formatDate, formatDuration, formatRelativeTime } from '@/lib/utils';
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

/** `TIMED_OUT` → "Timed out". */
function sentence(status: string): string {
  const words = status.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What a settled step shows in place of the bare status. A reject also resolves the step, so
 * "resolved" in green would read as success; the decision itself is the useful word.
 */
function settledBadge(step: HumanStepSummary): { label: string; tone: BadgeTone } {
  if (step.status !== 'RESOLVED') {
    return {
      label: sentence(step.status),
      tone: STATUS_TONE[step.status] ?? 'brick',
    };
  }
  const decision = step.responses?.at(-1)?.action;
  if (step.kind === 'APPROVAL' && decision === 'reject') {
    return { label: 'Rejected', tone: 'brick' };
  }
  if (step.kind === 'APPROVAL' && decision === 'approve') {
    return { label: 'Approved', tone: 'moss' };
  }
  return { label: 'Resolved', tone: 'moss' };
}

/** Auto-generated ticket ids (a UUID or an agent-run id) say nothing to a person. */
function isOpaqueTicketId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) || /^agent-[0-9a-f]/i.test(id);
}

/** The name of the request a step belongs to: its ticket id, or its description when the id is opaque. */
function requestLabel(
  request: { description?: string | null; externalTicketId?: string | null } | null | undefined
): string | null {
  const ticket = request?.externalTicketId?.trim();
  if (ticket && !isOpaqueTicketId(ticket)) {
    return ticket;
  }
  const description = request?.description?.trim().split('\n')[0];
  if (description) {
    return description.length > 80 ? `${description.slice(0, 79)}…` : description;
  }
  return ticket ?? null;
}

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
  select: 'Chose',
  submit: 'Submitted',
};

/** How each recorded answer is marked in the response list. */
const RESPONSE_ICON: Record<string, { icon: IconName; tone: string }> = {
  approve: { icon: 'checkCircle', tone: 'text-moss-400' },
  reject: { icon: 'error', tone: 'text-brick-400' },
  select: { icon: 'check', tone: 'text-dust-400' },
  submit: { icon: 'chat', tone: 'text-dust-400' },
};

const LINK = cn('rounded-sm transition-colors hover:text-ember-300 hover:underline', FOCUS_RING);

/** The server caps an approver's note; the counter keeps the limit visible. */
const MAX_COMMENT_LENGTH = 2000;

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

  const settled = step.status !== 'PENDING' ? settledBadge(step) : null;
  const request = requestLabel(step.run.workRequest);
  const requestedAt = new Date(step.requestedAt);

  return (
    <Card className="space-y-3 p-4" variant="inset">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 sm:flex-nowrap">
        <Badge className="mt-px shrink-0" tone={KIND_TONE[step.kind] ?? 'neutral'}>
          {KIND_LABEL[step.kind] ?? step.kind}
        </Badge>
        <div className="min-w-0 flex-1 basis-[14rem]">
          <div className="break-words text-sm font-semibold leading-snug text-paper-50">
            {step.title}
          </div>
          {step.description && (
            <div className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-paper-400">
              {step.description}
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-paper-500">
            <span
              className={cn('inline-flex items-center gap-1', getTimestampColor(step.requestedAt))}
              title={`Requested ${formatDate(requestedAt)}`}
            >
              <Icon name="clock" size={12} />
              Requested {formatRelativeTime(step.requestedAt)}
            </span>
            {step.status === 'PENDING' && step.timeoutAt && !expired && (
              <>
                <span aria-hidden="true">·</span>
                <span
                  className={getTimeoutColor(String(step.timeoutAt))}
                  title={formatDate(String(step.timeoutAt))}
                >
                  {formatTimeRemaining(String(step.timeoutAt))}
                </span>
              </>
            )}
            {step.kind === 'APPROVAL' && step.requiredApprovers && step.requiredApprovers > 1 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular text-paper-400">
                  {step.currentApprovers ?? 0} of {step.requiredApprovers} approvals
                </span>
              </>
            )}
          </div>
          {showRunLink && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              {request && (
                <>
                  {requestId ? (
                    <Link className={cn(LINK, 'text-paper-300')} href={requestHref(requestId)}>
                      {request}
                    </Link>
                  ) : (
                    <span className="text-paper-400">{request}</span>
                  )}
                  <span aria-hidden="true" className="text-paper-600">
                    ·
                  </span>
                </>
              )}
              <Link
                className={cn(LINK, 'text-ember-400')}
                href={requestId ? requestHref(requestId) : `/runs/${step.run.id}`}
              >
                View request
              </Link>
              {requestId && (
                <>
                  <span aria-hidden="true" className="text-paper-600">
                    ·
                  </span>
                  <Link className={cn(LINK, 'text-paper-400')} href={`/runs/${step.run.id}`}>
                    Full diagnostics
                  </Link>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-end">
          {youApproved && (
            <Badge className="shrink-0" dot tone="moss">
              You approved
            </Badge>
          )}
          {expired && (
            <Badge className="shrink-0" tone="muted">
              Expired
            </Badge>
          )}
          {settled && (
            <Badge className="shrink-0" dot tone={settled.tone}>
              {settled.label}
            </Badge>
          )}
          {canRespond && (
            <Button
              aria-expanded={expanded}
              className="h-[40px] lg:h-7"
              onClick={toggleExpanded}
              size="sm"
              variant={expanded ? 'ghost' : 'secondary'}
            >
              {expanded ? 'Collapse' : 'Respond'}
            </Button>
          )}
        </div>
      </div>

      {responses.length > 0 && (
        <ul className="space-y-2 border-t border-ink-600 pt-3 text-[13px]">
          {responses.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: responses are an ordered, append-only list
            <li className="flex gap-2.5 text-paper-300" key={i}>
              <Icon
                className={cn('mt-0.5', RESPONSE_ICON[r.action]?.tone ?? 'text-paper-500')}
                name={RESPONSE_ICON[r.action]?.icon ?? 'chat'}
                size={14}
              />
              <div className="min-w-0">
                <span className="font-medium text-paper-200">
                  {r.byName ?? 'Someone'} · {ACTION_LABEL[r.action] ?? r.action}
                </span>
                {r.comment && (
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-paper-400">
                    {r.comment}
                  </p>
                )}
                {r.value && (
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-paper-400">{r.value}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {expanded && canRespond && (
        <div className="space-y-4 border-t border-ink-600 pt-4">
          {/* A failed approve or reject is already shown inside its dialog. */}
          {respond.isError && !['approve', 'reject'].includes(respond.variables?.action ?? '') && (
            <Alert variant="error">
              {respond.error?.message ?? 'Submission failed. Please try again.'}
            </Alert>
          )}

          {/* Context for APPROVAL / DECISION is what the decision rests on, so it is open. */}
          {(step.kind === 'APPROVAL' || step.kind === 'DECISION') && hasContext && (
            <div className="space-y-1.5">
              <h4 className="text-xs font-medium text-paper-400">Context</h4>
              <DiffRenderer content={contextStr} />
            </div>
          )}

          {step.kind === 'APPROVAL' && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-500/50 bg-ink-900/50 px-3 py-2.5">
              <p className="min-w-0 flex-1 basis-[14rem] text-xs text-paper-400">
                {hasContext
                  ? 'Review the context above, then decide. Either way you can leave a note.'
                  : 'Decide on this step. Either way you can leave a note.'}
              </p>
              <div className="flex gap-2 max-sm:w-full max-sm:*:flex-1">
                <Button
                  className="h-[40px] lg:h-7"
                  disabled={respond.isPending}
                  onClick={() => openDialog('reject')}
                  size="sm"
                  variant="danger"
                >
                  <Icon name="close" size={13} />
                  Reject
                </Button>
                <Button
                  className="h-[40px] lg:h-7"
                  disabled={respond.isPending}
                  onClick={() => openDialog('approve')}
                  size="sm"
                  variant="primary"
                >
                  <Icon name="check" size={13} />
                  Approve
                </Button>
              </div>
            </div>
          )}

          {step.kind === 'DECISION' && isDecisionOptions(step.options) && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-paper-400">Choose one</h4>
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
            </div>
          )}

          {step.kind === 'INPUT' && isInputFields(step.fields) && (
            <div className="max-w-xl space-y-3">
              {inputError && <Alert variant="error">{inputError}</Alert>}
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
                  <h4 className="text-xs font-medium text-paper-400">Context</h4>
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
        dismissible={pendingAction === null}
        onClose={() => setDialog(null)}
        open={dialog !== null}
        title={dialog === 'reject' ? 'Reject this step?' : 'Approve this step?'}
      >
        <p className="text-sm text-paper-400">
          {dialog === 'reject'
            ? 'The workflow is told this step was rejected and continues down its rejection path. This cannot be undone.'
            : approveConsequence(step)}
        </p>
        <Textarea
          compact
          hint={`${comment.length} / ${MAX_COMMENT_LENGTH}`}
          id={`human-step-${step.id}-comment`}
          label={dialog === 'reject' ? 'Reason (required)' : 'Comment (optional)'}
          maxLength={MAX_COMMENT_LENGTH}
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
