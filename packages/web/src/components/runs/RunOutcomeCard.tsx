'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { isAgentRunTemplate } from '@/lib/agentRun';
import { isRecord } from '@/lib/utils';
import { AgentRunOutcomeCard } from './AgentRunOutcomeCard';

interface RunOutcomeCardProps {
  result: unknown;
  templateName: string;
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
      className="inline-flex items-center gap-1 text-ember-400 transition-colors hover:text-ember-600"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <span className="truncate max-w-[220px]" title={href}>
        {label}
      </span>
      <span className="font-mono text-[11px]">↗</span>
    </Link>
  );
}

export function RunOutcomeCard({ result, templateName }: RunOutcomeCardProps) {
  if (!isRecord(result)) {
    return null;
  }

  const name = templateName;

  if (isAgentRunTemplate(name)) {
    return <AgentRunOutcomeCard result={result} />;
  }

  if (
    name === 'notion-content-draft' ||
    name === 'notion-content-brand-review' ||
    name === 'product-prd-draft'
  ) {
    const pageId = typeof result.targetPageId === 'string' ? result.targetPageId : undefined;
    return (
      <Card className="p-3" variant="inset">
        <div className="label-mono mb-2">Outcome</div>
        {pageId ? (
          <div className="mb-2">
            <OutcomeLink href={notionUrl(pageId)} label={`Notion page ${pageId}`} />
          </div>
        ) : null}
        <p className="text-paper-300 text-[12px] leading-relaxed whitespace-pre-wrap">
          {truncate(result.text)}
        </p>
      </Card>
    );
  }

  if (name === 'zendesk-ticket-reply') {
    const ticketId = typeof result.ticketId === 'string' ? result.ticketId : undefined;
    return (
      <Card className="p-3" variant="inset">
        <div className="label-mono mb-2">Outcome</div>
        {ticketId ? (
          <div className="mb-2 font-mono text-[12px] text-paper-300">Ticket {ticketId}</div>
        ) : null}
        <p className="text-paper-300 text-[12px] leading-relaxed whitespace-pre-wrap">
          {truncate(result.text)}
        </p>
      </Card>
    );
  }

  if (name === 'send-slack-update') {
    const channelId = typeof result.channelId === 'string' ? result.channelId : undefined;
    const posted = result.posted === true;
    return (
      <Card className="p-3" variant="inset">
        <div className="label-mono mb-2">Outcome</div>
        <div className="flex items-center gap-2 mb-2 text-[12px]">
          {channelId ? <span className="font-mono text-paper-300">#{channelId}</span> : null}
          <Badge tone={posted ? 'moss' : 'amber'}>{posted ? 'posted' : 'not posted'}</Badge>
        </div>
        <p className="text-paper-300 text-[12px] leading-relaxed whitespace-pre-wrap">
          {truncate(result.text)}
        </p>
      </Card>
    );
  }

  if (name === 'create-issue' || name === 'create-issue-from-brief') {
    const rawIssueUrl = typeof result.issueUrl === 'string' ? result.issueUrl : undefined;
    const issueUrl = rawIssueUrl && isSafeWebUrl(rawIssueUrl) ? rawIssueUrl : undefined;
    const title = typeof result.title === 'string' ? result.title : undefined;
    return (
      <Card className="p-3" variant="inset">
        <div className="label-mono mb-2">Outcome</div>
        {issueUrl ? (
          <div className="mb-2">
            <OutcomeLink href={issueUrl} label={title ?? issueUrl} />
          </div>
        ) : null}
        <p className="text-paper-300 text-[12px] leading-relaxed whitespace-pre-wrap">
          {truncate(result.description)}
        </p>
      </Card>
    );
  }

  return null;
}
