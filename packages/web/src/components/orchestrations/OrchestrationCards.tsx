'use client';

import type {
  OrchestrationApprovalDto,
  OrchestrationDetailDto,
  OrchestrationMessageDto,
} from '@auto-swe/shared/lib/orchestrationApi';
import { useState } from 'react';
import { useNow } from '@/components/orchestrations/useNow';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { useRepositories } from '@/hooks/useRepositories';
import { connectionLabel } from '@/lib/connectionDisplay';
import {
  APPROVAL_OUTCOME_LABELS,
  type ApprovalOutcome,
  asApprovalStatus,
  coerceResult,
  countdown,
  deliveryLabel,
  httpsUrl,
  parseApprovalPayload,
  parseAttachPayload,
  parseChildResultPayload,
  payloadString,
} from '@/lib/orchestration';
import { groupedRepoOptions } from '@/lib/repoGroups';

const CARD = 'rounded-lg border border-ink-400 bg-ink-800/70 p-3 text-sm sm:p-4';

/** What attaching a repository grants, apart from the billing team and delivery default (shown from data). */
export const ATTACH_GRANTS = [
  'Writing agents and delivery (branches and draft pull requests) become available.',
  'Agents already running are not changed. The repository can be attached once.',
];

export interface ControlProps {
  /** The answer was sent; the buttons stay off until the item leaves the pending list. */
  decided?: boolean;
  /** A failed action's message, shown inside the card. */
  error?: string | null;
  /** A neutral note, such as "already decided". */
  note?: string | null;
}

type PendingAttach = NonNullable<OrchestrationDetailDto['pendingAttach']>;

/**
 * The agent's request for a repository, from the detail's `pendingAttach` (authoritative): the
 * reason, the fully qualified repository, and what saying yes grants. Says plainly when the
 * gateway did not report a field.
 */
export function AttachRequestCard({
  canControl,
  decided,
  detail,
  error,
  message,
  note,
  onAttach,
  onDecline,
  pending,
}: ControlProps & {
  canControl: boolean;
  detail: OrchestrationDetailDto;
  /** The transcript message of the request, when loaded; a fallback for the text fields. */
  message?: OrchestrationMessageDto;
  onAttach: (repoId: string) => void;
  onDecline: () => void;
  pending: PendingAttach;
}) {
  const payload = message ? parseAttachPayload(message.payload) : null;
  const reason = pending.reason || payload?.reason || '';
  const candidateId = pending.candidateRepoId ?? payload?.candidateRepoId ?? null;
  const repos = useRepositories({ limit: 500 });
  const gitRepos = (repos.data ?? []).filter((r) => r.type === 'git_repo');
  const candidate = candidateId ? gitRepos.find((r) => r.id === candidateId) : undefined;
  const [picked, setPicked] = useState('');
  const chosenId = candidate?.id ?? picked;
  const chosen = gitRepos.find((r) => r.id === chosenId);
  const repoName = pending.candidateRepoName ?? (candidate ? connectionLabel(candidate) : null);
  const billing =
    pending.billingTeamName ?? detail.billing?.childrenTeamName ?? chosen?.team?.name ?? null;
  const delivery = deliveryLabel(pending.deliveryDefault ?? detail.deliveryDefault);
  const locked = decided || !canControl;

  return (
    <section aria-label="Repository request" className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-paper-100">Repository request</h3>
        <Badge tone="warning">
          {canControl ? 'Needs your answer' : 'Waiting for the launcher'}
        </Badge>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-paper-300">{reason}</p>
      <p className="mt-2 break-words text-paper-300">
        Repository:{' '}
        {repoName ? (
          <span className="break-all font-mono text-paper-100">{repoName}</span>
        ) : candidateId ? (
          <span className="text-paper-400">suggested, but its name is not available to you</span>
        ) : (
          <span className="text-paper-400">none suggested. Choose one below.</span>
        )}
      </p>
      <div className="mt-3">
        <div className="label-mono">Attaching grants</div>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-paper-300">
          <li>{ATTACH_GRANTS[0]}</li>
          <li className="break-words">
            {billing
              ? `Agents started from now on run and bill under ${billing}.`
              : 'Agents started from now on run and bill under the repository’s owning team (the team was not reported).'}
          </li>
          <li>
            {delivery
              ? `Delivery default: ${delivery}.`
              : 'Delivery default: not reported. The one chosen at launch applies.'}{' '}
            Nothing is merged for you.
          </li>
          <li>{ATTACH_GRANTS[1]}</li>
        </ul>
      </div>
      {canControl && !decided && !candidate && (
        <div className="mt-3">
          <Combobox
            emptyMessage="No repositories match"
            label="Repository to attach"
            onChange={setPicked}
            options={groupedRepoOptions(gitRepos, null, connectionLabel)}
            placeholder={repos.isLoading ? 'Loading…' : 'Choose a repository…'}
            value={picked}
          />
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Alert variant="error">{error}</Alert>
        </div>
      )}
      {note && <p className="mt-3 text-paper-400">{note}</p>}
      {canControl ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={locked || !chosenId}
            onClick={() => onAttach(chosenId)}
            variant="primary"
          >
            Attach repository
          </Button>
          <Button disabled={locked} onClick={onDecline} variant="secondary">
            Decline
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-paper-500">Waiting for the person who launched this.</p>
      )}
    </section>
  );
}

/** `HH:MM` of an instant, in the viewer's locale; null when the text is not a date. */
function clockTime(iso: string): string | null {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
}

/**
 * One MCP write waiting for the launcher, from the detail's `pendingApprovals`: what it is, when
 * it expires, approve and deny. The expiry is announced once as a clock time; the ticking
 * countdown is for sighted users and hidden from assistive technology.
 */
export function ApprovalCard({
  approval,
  canControl,
  decided,
  error,
  note,
  onDecide,
}: ControlProps & {
  approval: OrchestrationApprovalDto;
  canControl: boolean;
  onDecide: (approvalId: string, decision: 'APPROVE' | 'DENY') => void;
}) {
  const now = useNow(true);
  const left = countdown(approval.expiresAt, now);
  const expired = left === null;
  const clock = clockTime(approval.expiresAt);
  const deciding = !expired && !decided;

  return (
    <section aria-label="Approval request" className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-paper-100">Approval needed</h3>
        <Badge tone={expired ? 'neutral' : 'warning'}>
          {expired ? 'Expired' : 'Waiting for approval'}
        </Badge>
        <span className="text-paper-400">
          {clock ? `Expires at ${clock}` : 'Expiry time unknown'}
          {left && (
            <span aria-hidden="true" className="tabular-nums">
              {' '}
              ({left} left)
            </span>
          )}
        </span>
      </div>
      <p className="mt-2 text-paper-300">
        An agent wants to call{' '}
        <span className="break-all font-mono text-paper-100">{approval.toolName}</span> on{' '}
        <span className="break-words text-paper-100">
          {approval.connectionName ?? 'an MCP connection'}
        </span>
        . It is not known to be read-only, so it waits for you.
      </p>
      {approval.argumentsDigest && (
        <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-sm bg-ink-900/60 p-2 font-mono text-xs text-paper-300">
          {approval.argumentsDigest}
        </pre>
      )}
      {error && (
        <div className="mt-3">
          <Alert variant="error">{error}</Alert>
        </div>
      )}
      {note && <p className="mt-3 text-paper-400">{note}</p>}
      {canControl && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={!deciding}
            onClick={() => onDecide(approval.id, 'APPROVE')}
            variant="primary"
          >
            Approve this call
          </Button>
          <Button
            disabled={!deciding}
            onClick={() => onDecide(approval.id, 'DENY')}
            variant="secondary"
          >
            Deny
          </Button>
        </div>
      )}
    </section>
  );
}

const ROW = 'rounded-lg border border-dashed border-ink-400 px-3 py-2 text-sm text-paper-300';

/** An attach request in the transcript: plain text and a label for how it ended. */
export function AttachRequestRow({
  detail,
  message,
}: {
  detail: OrchestrationDetailDto;
  message: OrchestrationMessageDto;
}) {
  const payload = parseAttachPayload(message.payload);
  const reason = payload?.reason ?? payloadString(message.payload, 'reason') ?? '';
  const resolution = payload?.resolution ?? payloadString(message.payload, 'resolution');
  const open = detail.pendingAttach?.messageId === message.id;
  const outcome = open
    ? { label: 'Waiting for an answer', tone: 'warning' as const }
    : resolution === 'ATTACHED'
      ? { label: 'Attached', tone: 'success' as const }
      : resolution === 'DECLINED'
        ? { label: 'Declined', tone: 'neutral' as const }
        : { label: 'Closed', tone: 'neutral' as const };
  return (
    <div className={ROW}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-paper-200">Repository request</span>
        <Badge tone={outcome.tone}>{outcome.label}</Badge>
      </div>
      {reason && <p className="mt-1 whitespace-pre-wrap break-words">{reason}</p>}
    </div>
  );
}

const OUTCOME_TONE: Record<ApprovalOutcome, 'warning' | 'success' | 'neutral' | 'danger'> = {
  APPROVED: 'success',
  DENIED: 'danger',
  EXPIRED: 'neutral',
  PENDING: 'warning',
};

/**
 * An approval request in the transcript. Its status comes from the detail (which lists the
 * request while it is pending and carries a decided one's status), else from the payload; a
 * stored `PENDING` the detail no longer lists is stale and reads as resolved.
 */
export function ApprovalRequestRow({
  detail,
  message,
}: {
  detail: OrchestrationDetailDto;
  message: OrchestrationMessageDto;
}) {
  const payload = parseApprovalPayload(message.payload);
  const approvalId = payload?.approvalId ?? payloadString(message.payload, 'approvalId');
  const live = approvalId ? detail.pendingApprovals.find((a) => a.id === approvalId) : undefined;
  const fromPayload = asApprovalStatus(payloadString(message.payload, 'status'));
  const status: ApprovalOutcome | null =
    live?.status ?? (fromPayload && fromPayload !== 'PENDING' ? fromPayload : null);
  const toolName =
    live?.toolName ?? payload?.toolName ?? payloadString(message.payload, 'toolName');
  const connection =
    live?.connectionName ??
    payload?.connectionName ??
    payloadString(message.payload, 'connectionName');
  return (
    <div className={ROW}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-paper-200">Approval request</span>
        <Badge tone={status ? OUTCOME_TONE[status] : 'neutral'}>
          {status ? APPROVAL_OUTCOME_LABELS[status] : 'Resolved'}
        </Badge>
      </div>
      {toolName && (
        <p className="mt-1 break-words">
          <span className="break-all font-mono">{toolName}</span>
          {connection ? ` on ${connection}` : ''}
        </p>
      )}
    </div>
  );
}

/** A finished child's structured result. Every string is text; only an https PR link is a link. */
export function ChildResultCard({
  detail,
  message,
}: {
  detail: OrchestrationDetailDto;
  message: OrchestrationMessageDto;
}) {
  const childId = message.childId ?? parseChildResultPayload(message.payload)?.childId;
  const child = detail.children.find((c) => c.id === childId);
  const result =
    coerceResult(message.payload?.result ?? message.payload) ?? coerceResult(child?.result);
  const rawPr = result?.prUrl ?? child?.prUrl ?? null;
  const prUrl = httpsUrl(rawPr);
  const branch = result?.branch ?? child?.branch ?? null;
  return (
    <section aria-label="Agent result" className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="break-words font-medium text-paper-100">
          Result from {child?.label ?? 'an agent'}
        </h3>
        {result && (
          <Badge tone={result.status === 'COMPLETED' ? 'success' : 'danger'}>
            {result.status.toLowerCase()}
          </Badge>
        )}
      </div>
      {result ? (
        <>
          <p className="mt-2 whitespace-pre-wrap break-words text-paper-300">{result.summary}</p>
          {result.filesChanged.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-paper-400">
                {result.filesChanged.length} file{result.filesChanged.length === 1 ? '' : 's'}{' '}
                changed
              </summary>
              <ul className="mt-1 space-y-0.5 font-mono text-xs text-paper-300">
                {result.filesChanged.map((f) => (
                  <li className="break-all" key={f.path}>
                    {f.path} <span className="text-success-400">+{f.added}</span>{' '}
                    <span className="text-danger-400">-{f.removed}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        <p className="mt-2 text-paper-500">The result is not available.</p>
      )}
      {(branch || rawPr) && (
        <dl className="mt-2 space-y-1 text-paper-300">
          {branch && (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-paper-500">Branch</dt>
              <dd className="break-all font-mono text-xs">{branch}</dd>
            </div>
          )}
          {rawPr && (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-paper-500">Pull request</dt>
              <dd className="break-all">
                {prUrl ? (
                  <a
                    className="text-accent-400 underline underline-offset-2"
                    href={prUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {prUrl}
                  </a>
                ) : (
                  rawPr
                )}
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
