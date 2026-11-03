'use client';

import { NO_CRITERIA_REASON } from '@auto-swe/shared/lib/agentPrompts';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Icon, type IconName } from '@/components/ui/Icon';
import { cn, FOCUS_RING, isRecord } from '@/lib/utils';
import { AgentRunOutcomeCard } from './AgentRunOutcomeCard';
import { ArtifactAwareText } from './ArtifactAwareText';

interface RunOutcomeCardProps {
  result: unknown;
  /** The run the result belongs to; a spilled value is read through it. */
  runId: string;
  templateName: string;
  /** A run of the hidden Agent Run template, as the gateway reports it (not inferred from the name). */
  isAgentRun?: boolean;
}

function truncate(value: unknown, maxChars = 240): string {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}…`;
}

function notionUrl(pageId: string): string {
  return `https://notion.so/${pageId}`;
}

function isSafeWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Why the tracker ticket could not be read, by the class the gatherer recorded, in words that do
 * not blame the requester: a refused fetch and a missing ticket look the same to a tracker. A
 * lookup table, never the stored value, so nothing a run produced is shown beyond a known class.
 * Its keys are the `TicketFailureClass` set (a test fails when they drift apart).
 */
const UNREAD = 'The ticket could not be read from the tracker';
export const TICKET_UNAVAILABLE_LINES = new Map<string, string>([
  ['unauthorized', `${UNREAD} (the tracker rejected its credentials).`],
  ['forbidden', `${UNREAD} (access was refused).`],
  ['not_found', `${UNREAD} (access was refused, or it does not exist).`],
  ['rate_limited', `${UNREAD} (the tracker is limiting requests).`],
  ['server_error', `${UNREAD} (the tracker returned an error).`],
  ['timeout', `${UNREAD} (the tracker did not answer in time).`],
  ['network', `${UNREAD} (the tracker could not be reached).`],
  ['redirect', `${UNREAD} (the tracker address redirects, which is not followed).`],
  // Write-only, so unreachable here (the card only renders these for a read failure): a refused
  // read is reported as `not_found`, and a read never produces the next three. Kept so the table
  // stays aligned with the class set, with standalone text that does not claim a failed read.
  ['out_of_scope', 'The ticket is in a repository this run does not target.'],
  [
    'no_repository',
    'The platform could not resolve a repository from the ticket id, so it did not write to it.',
  ],
  [
    'no_transition',
    'No transition to a status named like the one the platform looks for was found on the ticket (the project may name its statuses differently), so nothing was written.',
  ],
  ['rejected', `${UNREAD} (it rejected the request).`],
  ['refused', `${UNREAD} (it was blocked by the platform's network policy).`],
  ['unconfigured', `${UNREAD} (no ticket tracker is configured).`],
  ['empty', 'The ticket was read from the tracker but has no text.'],
  // Also the catch-all for a failure inside the platform (a database error, say): not the tracker.
  ['unknown', 'The ticket could not be read (the reason is not known).'],
]);

/**
 * What to do about each unreadable-ticket class: the single carrier of the next step (the lines
 * only say what happened). Same rule as the lines: a closed lookup, plain text. Its keys are the
 * failure classes that are read failures, i.e. all but the NOT_READ classes: `empty`, `out_of_scope`,
 * `no_repository` and `no_transition` (a test fails when they drift apart).
 */
const PLATFORM =
  "This is a problem with the platform's tracker connection, not the requester's ticket";
const RETRY = 'try again in a few minutes, and if it keeps happening ask an administrator to';
export const TICKET_UNAVAILABLE_HINTS = new Map<string, string>([
  [
    'unauthorized',
    `${PLATFORM}: ask an administrator to check the tracker credentials and settings.`,
  ],
  ['forbidden', `${PLATFORM}: ask an administrator to check the tracker credentials and settings.`],
  [
    'not_found',
    "The tracker token may not be able to see this ticket, or the ticket id may be wrong: ask an administrator to check the token's access, and check the id.",
  ],
  ['rate_limited', `${PLATFORM}: ${RETRY} check the tracker's request limits.`],
  ['server_error', `${PLATFORM}: ${RETRY} check the tracker's status and settings.`],
  ['timeout', `${PLATFORM}: ${RETRY} check the tracker's responsiveness and settings.`],
  ['network', `${PLATFORM}: ${RETRY} check the tracker address and network access.`],
  ['redirect', `${PLATFORM}: ask an administrator to check the tracker address in its settings.`],
  ['rejected', `${PLATFORM}: ask an administrator to check the tracker settings.`],
  [
    'refused',
    `${PLATFORM}: ask an administrator to check the tracker's allowed addresses and network policy.`,
  ],
  ['unconfigured', `${PLATFORM}: ask an administrator to configure the ticket tracker.`],
  [
    'unknown',
    "This may be a problem on the platform's side, not the requester's ticket: try again, and if it keeps happening ask an administrator to check the platform logs.",
  ],
]);

/** Shown instead of the stored message when the ticket could not be read (own copy, no stored text). */
export const TICKET_UNAVAILABLE_WORKAROUND =
  'In the meantime you can paste the ticket text into the request, or add acceptance criteria, and run it again.';

function ticketUnavailableHint(reason: unknown): string | null {
  return typeof reason === 'string' ? (TICKET_UNAVAILABLE_HINTS.get(reason) ?? null) : null;
}

function ticketUnavailableLine(reason: unknown): string | null {
  return typeof reason === 'string' ? (TICKET_UNAVAILABLE_LINES.get(reason) ?? null) : null;
}

function OutcomeLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-sm text-sm font-medium text-paper-100 underline-offset-2 hover:underline focus-visible:underline',
        FOCUS_RING
      )}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <span className="min-w-0 truncate" title={href}>
        {label}
      </span>
      <Icon name="external" size={13} />
    </Link>
  );
}

/** The frame every outcome shares: a titled inset card, so a result reads the same for any template. */
function OutcomeShell({
  children,
  icon,
  title = 'Outcome',
  tone = 'success',
}: {
  children: ReactNode;
  icon: IconName;
  title?: string;
  /** `warning` for a run that stopped without finishing its work; every other card is `success`. */
  tone?: 'success' | 'warning';
}) {
  return (
    <Card className="space-y-2.5 p-4" variant="inset">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-paper-100">
        <Icon
          className={tone === 'warning' ? 'text-warning-400' : 'text-success-400'}
          name={icon}
          size={15}
        />
        {title}
      </h3>
      {children}
    </Card>
  );
}

/** A run's text output: preserved line breaks, cut to a preview. */
function OutcomeText({ runId, value }: { runId: string; value: unknown }) {
  const text = truncate(value);
  if (!text) {
    return null;
  }
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-paper-300">
      <ArtifactAwareText runId={runId} text={text} />
    </p>
  );
}

export function RunOutcomeCard({ result, runId, templateName, isAgentRun }: RunOutcomeCardProps) {
  if (!isRecord(result)) {
    return null;
  }

  if (isAgentRun) {
    return <AgentRunOutcomeCard result={result} runId={runId} />;
  }

  if (typeof result.prUrl === 'string' && isSafeWebUrl(result.prUrl)) {
    return (
      <OutcomeShell icon="pullRequest" title="Pull request">
        <OutcomeLink
          href={result.prUrl}
          label={
            typeof result.prNumber === 'number'
              ? `Review PR #${result.prNumber}`
              : 'Review pull request'
          }
        />
      </OutcomeShell>
    );
  }

  const name = templateName;

  if (
    name === 'notion-content-draft' ||
    name === 'notion-content-brand-review' ||
    name === 'product-prd-draft'
  ) {
    const pageId = typeof result.targetPageId === 'string' ? result.targetPageId : undefined;
    return (
      <OutcomeShell icon="docs">
        {pageId ? <OutcomeLink href={notionUrl(pageId)} label={`Notion page ${pageId}`} /> : null}
        <OutcomeText runId={runId} value={result.text} />
      </OutcomeShell>
    );
  }

  if (name === 'zendesk-ticket-reply') {
    const ticketId = typeof result.ticketId === 'string' ? result.ticketId : undefined;
    return (
      <OutcomeShell icon="ticket">
        {ticketId ? (
          <div className="text-sm text-paper-400">
            Ticket <span className="font-mono text-paper-200">{ticketId}</span>
          </div>
        ) : null}
        <OutcomeText runId={runId} value={result.text} />
      </OutcomeShell>
    );
  }

  if (name === 'send-slack-update') {
    const channelId = typeof result.channelId === 'string' ? result.channelId : undefined;
    const posted = result.posted === true;
    return (
      <OutcomeShell icon="chat">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {channelId ? <span className="font-mono text-paper-200">#{channelId}</span> : null}
          <Badge dot tone={posted ? 'success' : 'warning'}>
            {posted ? 'Posted' : 'Not posted'}
          </Badge>
        </div>
        <OutcomeText runId={runId} value={result.text} />
      </OutcomeShell>
    );
  }

  if (name === 'create-issue' || name === 'create-issue-from-brief') {
    const rawIssueUrl = typeof result.issueUrl === 'string' ? result.issueUrl : undefined;
    const issueUrl = rawIssueUrl && isSafeWebUrl(rawIssueUrl) ? rawIssueUrl : undefined;
    const title = typeof result.title === 'string' ? result.title : undefined;
    return (
      <OutcomeShell icon="ticket">
        {issueUrl ? <OutcomeLink href={issueUrl} label={title ?? issueUrl} /> : null}
        <OutcomeText runId={runId} value={result.description} />
      </OutcomeShell>
    );
  }

  // A run that stopped on purpose says why in `message`, with the open questions in `ambiguities`
  // (the `ticket-to-merge` stop on an unactionable request). Plain text nodes only.
  if (typeof result.message === 'string' && result.message !== '') {
    const ambiguities = Array.isArray(result.ambiguities)
      ? [...new Set(result.ambiguities.filter((item): item is string => typeof item === 'string'))]
      : [];
    const ticketLine = ticketUnavailableLine(result.ticketUnavailableReason);
    // An integration failure (the ticket could not be read) leads the card; the stored message, which
    // describes a ticket the platform never saw, is not shown, and the model's ambiguities move
    // into a collapsed details.
    const ticketHint = ticketUnavailableHint(result.ticketUnavailableReason);
    const unreadable = ticketHint !== null;
    return (
      <OutcomeShell icon="warning" title="Stopped" tone="warning">
        {unreadable ? (
          <>
            <p className="text-sm font-medium leading-relaxed text-paper-100">{ticketLine}</p>
            <p className="text-sm leading-relaxed text-paper-300">{ticketHint}</p>
            <p className="text-sm leading-relaxed text-paper-300">
              {TICKET_UNAVAILABLE_WORKAROUND}
            </p>
            {/* Only the no-criteria reason restates the heading: nothing was noted, so no disclosure. */}
            {ambiguities.some((item) => item !== NO_CRITERIA_REASON) ? (
              <details className="group rounded-lg border border-ink-400/60 bg-ink-900/40 px-4 py-3">
                <summary
                  className={cn(
                    'flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-sm font-medium text-paper-200 [&::-webkit-details-marker]:hidden',
                    FOCUS_RING
                  )}
                >
                  <Icon
                    className="text-paper-500 transition-transform group-open:rotate-90"
                    name="chevronRight"
                    size={14}
                  />
                  What validation noted about the request text on its own
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-paper-300">
                  {ambiguities.map((item) => (
                    <li className="break-words" key={item}>
                      {truncate(item, 500)}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : (
          <OutcomeText runId={runId} value={result.message} />
        )}
        {ticketLine && !unreadable ? (
          <p className="text-sm leading-relaxed text-paper-300">{ticketLine}</p>
        ) : null}
        {!unreadable && ambiguities.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-paper-300">
            {ambiguities.map((item) => (
              <li className="break-words" key={item}>
                {truncate(item, 500)}
              </li>
            ))}
          </ul>
        ) : null}
      </OutcomeShell>
    );
  }

  return null;
}
