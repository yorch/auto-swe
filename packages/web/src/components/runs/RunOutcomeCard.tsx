'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Icon, type IconName } from '@/components/ui/Icon';
import { cn, FOCUS_RING, isRecord } from '@/lib/utils';
import { AgentRunOutcomeCard } from './AgentRunOutcomeCard';

interface RunOutcomeCardProps {
  result: unknown;
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

function OutcomeLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-sm text-sm font-medium text-ember-400 transition-colors hover:text-ember-300',
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
}: {
  children: ReactNode;
  icon: IconName;
  title?: string;
}) {
  return (
    <Card className="space-y-2.5 p-4" variant="inset">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-paper-100">
        <Icon className="text-moss-400" name={icon} size={15} />
        {title}
      </h3>
      {children}
    </Card>
  );
}

/** A run's text output: preserved line breaks, cut to a preview. */
function OutcomeText({ value }: { value: unknown }) {
  const text = truncate(value);
  if (!text) {
    return null;
  }
  return (
    <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-paper-300">
      {text}
    </p>
  );
}

export function RunOutcomeCard({ result, templateName, isAgentRun }: RunOutcomeCardProps) {
  if (!isRecord(result)) {
    return null;
  }

  if (isAgentRun) {
    return <AgentRunOutcomeCard result={result} />;
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
        <OutcomeText value={result.text} />
      </OutcomeShell>
    );
  }

  if (name === 'zendesk-ticket-reply') {
    const ticketId = typeof result.ticketId === 'string' ? result.ticketId : undefined;
    return (
      <OutcomeShell icon="ticket">
        {ticketId ? (
          <div className="text-[13px] text-paper-400">
            Ticket <span className="font-mono text-paper-200">{ticketId}</span>
          </div>
        ) : null}
        <OutcomeText value={result.text} />
      </OutcomeShell>
    );
  }

  if (name === 'send-slack-update') {
    const channelId = typeof result.channelId === 'string' ? result.channelId : undefined;
    const posted = result.posted === true;
    return (
      <OutcomeShell icon="chat">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          {channelId ? <span className="font-mono text-paper-200">#{channelId}</span> : null}
          <Badge dot tone={posted ? 'moss' : 'amber'}>
            {posted ? 'Posted' : 'Not posted'}
          </Badge>
        </div>
        <OutcomeText value={result.text} />
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
        <OutcomeText value={result.description} />
      </OutcomeShell>
    );
  }

  return null;
}
