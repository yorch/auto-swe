'use client';

import type {
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
import { coerceResult, countdown, httpsUrl, payloadString } from '@/lib/orchestration';
import { groupedRepoOptions } from '@/lib/repoGroups';

const CARD = 'rounded-lg border border-ink-400 bg-ink-800/70 p-3 text-sm sm:p-4';

/** What attaching a repository grants. Fixed wording: the request's own text is shown apart. */
export const ATTACH_GRANTS = [
  'Writing agents and delivery (branches and draft pull requests) become available.',
  'Agents started from now on run and bill under the repository’s owning team.',
  'Agents already running are not changed. The repository can be attached once.',
];

export interface ControlProps {
  /** An in-flight or failed action's message, shown inside the card. */
  error?: string | null;
  pending?: boolean;
}

/** The agent's request for a repository: the reason, the candidate, and what saying yes grants. */
export function AttachRequestCard({
  canControl,
  detail,
  error,
  message,
  onAttach,
  onDecline,
  pending,
}: ControlProps & {
  canControl: boolean;
  detail: OrchestrationDetailDto;
  message: OrchestrationMessageDto;
  onAttach: (repoId: string) => void;
  onDecline: () => void;
}) {
  const open = detail.pendingAttach?.messageId === message.id;
  const reason =
    (open ? detail.pendingAttach?.reason : null) ?? payloadString(message.payload, 'reason') ?? '';
  const candidateId =
    (open ? detail.pendingAttach?.candidateRepoId : null) ??
    payloadString(message.payload, 'candidateRepoId');
  const interactive = open && canControl;
  const repos = useRepositories({ limit: 500 });
  const gitRepos = (repos.data ?? []).filter((r) => r.type === 'git_repo');
  const candidate = candidateId ? gitRepos.find((r) => r.id === candidateId) : undefined;
  const [picked, setPicked] = useState('');
  const chosen = candidate?.id ?? picked;
  const delivery = payloadString(message.payload, 'deliveryDefault');
  const outcome = detail.repoAttachedAt ? 'Attached' : 'Closed without a repository';

  return (
    <section aria-label="Repository request" className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-paper-100">Repository request</h3>
        <Badge tone={open ? 'warning' : 'neutral'}>{open ? 'Needs your answer' : outcome}</Badge>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-paper-300">{reason}</p>
      {candidateId && (
        <p className="mt-2 text-paper-300">
          Suggested repository:{' '}
          <span className="font-mono text-paper-100">
            {candidate ? connectionLabel(candidate) : 'a repository you can reach'}
          </span>
        </p>
      )}
      <div className="mt-3">
        <div className="label-mono">Attaching grants</div>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-paper-300">
          {ATTACH_GRANTS.map((grant) => (
            <li key={grant}>{grant}</li>
          ))}
          <li>
            Delivery default: {delivery ?? 'the one chosen at launch'}. Nothing is merged for you.
          </li>
        </ul>
      </div>
      {interactive && !candidate && (
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
      {interactive ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={pending || !chosen} onClick={() => onAttach(chosen)} variant="primary">
            Attach repository
          </Button>
          <Button disabled={pending} onClick={onDecline} variant="secondary">
            Decline
          </Button>
        </div>
      ) : (
        open && <p className="mt-3 text-paper-500">Waiting for the person who launched this.</p>
      )}
    </section>
  );
}

/** One MCP write waiting for the launcher: what it is, how long it has, approve and deny. */
export function ApprovalCard({
  canControl,
  detail,
  error,
  message,
  onDecide,
  pending,
}: ControlProps & {
  canControl: boolean;
  detail: OrchestrationDetailDto;
  message: OrchestrationMessageDto;
  onDecide: (approvalId: string, decision: 'APPROVE' | 'DENY') => void;
}) {
  const approvalId = payloadString(message.payload, 'approvalId');
  const live = detail.pendingApprovals.find((a) => a.id === approvalId);
  const toolName = live?.toolName ?? payloadString(message.payload, 'toolName') ?? 'a tool';
  const connection =
    live?.connectionName ?? payloadString(message.payload, 'connectionName') ?? 'an MCP connection';
  const digest = live?.argumentsDigest ?? payloadString(message.payload, 'argumentsDigest');
  const expiresAt = live?.expiresAt ?? payloadString(message.payload, 'expiresAt');
  const now = useNow(!!live);
  const left = live && expiresAt ? countdown(expiresAt, now) : null;
  const deciding = !!live && left !== null;
  const status = live
    ? left === null
      ? 'Expired'
      : 'Waiting for approval'
    : (payloadString(message.payload, 'status') ?? 'Resolved');

  return (
    <section aria-label="Approval request" className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-paper-100">Approval needed</h3>
        <Badge tone={deciding ? 'warning' : 'neutral'}>{status}</Badge>
        {deciding && left && (
          <span className="tabular-nums text-paper-400">
            <span className="sr-only">Time left: </span>
            {left}
          </span>
        )}
      </div>
      <p className="mt-2 text-paper-300">
        An agent wants to call <span className="font-mono text-paper-100">{toolName}</span> on{' '}
        <span className="text-paper-100">{connection}</span>. It is not known to be read-only, so it
        waits for you.
      </p>
      {digest && (
        <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-sm bg-ink-900/60 p-2 font-mono text-xs text-paper-300">
          {digest}
        </pre>
      )}
      {error && (
        <div className="mt-3">
          <Alert variant="error">{error}</Alert>
        </div>
      )}
      {canControl && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={!deciding || pending || !approvalId}
            onClick={() => approvalId && onDecide(approvalId, 'APPROVE')}
            variant="primary"
          >
            Approve this call
          </Button>
          <Button
            disabled={!deciding || pending || !approvalId}
            onClick={() => approvalId && onDecide(approvalId, 'DENY')}
            variant="secondary"
          >
            Deny
          </Button>
        </div>
      )}
    </section>
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
  const child = detail.children.find((c) => c.id === message.childId);
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
