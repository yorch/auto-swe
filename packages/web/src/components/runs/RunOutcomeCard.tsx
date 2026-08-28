'use client';

import Link from 'next/link';

interface RunOutcomeCardProps {
  result: unknown;
  templateName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function OutcomeLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      className="inline-flex items-center gap-1 text-ember-400 hover:text-ember-300 transition-colors"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <span className="truncate max-w-[220px]" title={href}>
        {label}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>↗</span>
    </Link>
  );
}

export function RunOutcomeCard({ result, templateName }: RunOutcomeCardProps) {
  if (!isRecord(result)) {
    return null;
  }

  const name = templateName;

  if (
    name === 'notion-content-draft' ||
    name === 'notion-content-brand-review' ||
    name === 'product-prd-draft'
  ) {
    const pageId = typeof result.targetPageId === 'string' ? result.targetPageId : undefined;
    return (
      <div className="border border-ink-600/40 rounded-md p-3 bg-ink-900/40">
        <div className="kicker mb-2 text-paper-500">Outcome</div>
        {pageId ? (
          <div className="mb-2">
            <OutcomeLink href={notionUrl(pageId)} label={`Notion page ${pageId}`} />
          </div>
        ) : null}
        <p className="text-paper-300 text-[12px] leading-relaxed whitespace-pre-wrap">
          {truncate(result.text)}
        </p>
      </div>
    );
  }

  if (name === 'zendesk-ticket-reply') {
    const ticketId = typeof result.ticketId === 'string' ? result.ticketId : undefined;
    return (
      <div className="border border-ink-600/40 rounded-md p-3 bg-ink-900/40">
        <div className="kicker mb-2 text-paper-500">Outcome</div>
        {ticketId ? (
          <div
            className="mb-2 text-paper-300 text-[12px]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            Ticket {ticketId}
          </div>
        ) : null}
        <p className="text-paper-300 text-[12px] leading-relaxed whitespace-pre-wrap">
          {truncate(result.text)}
        </p>
      </div>
    );
  }

  if (name === 'send-slack-update') {
    const channelId = typeof result.channelId === 'string' ? result.channelId : undefined;
    const posted = result.posted === true;
    return (
      <div className="border border-ink-600/40 rounded-md p-3 bg-ink-900/40">
        <div className="kicker mb-2 text-paper-500">Outcome</div>
        <div className="flex items-center gap-2 mb-2 text-[12px]">
          {channelId ? (
            <span className="text-paper-300" style={{ fontFamily: 'var(--font-mono)' }}>
              #{channelId}
            </span>
          ) : null}
          <span
            className={posted ? 'text-success-400' : 'text-ember-400'}
            style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
          >
            {posted ? 'posted' : 'not posted'}
          </span>
        </div>
        <p className="text-paper-300 text-[12px] leading-relaxed whitespace-pre-wrap">
          {truncate(result.text)}
        </p>
      </div>
    );
  }

  if (name === 'create-issue' || name === 'create-issue-from-brief') {
    const issueUrl = typeof result.issueUrl === 'string' ? result.issueUrl : undefined;
    const title = typeof result.title === 'string' ? result.title : undefined;
    return (
      <div className="border border-ink-600/40 rounded-md p-3 bg-ink-900/40">
        <div className="kicker mb-2 text-paper-500">Outcome</div>
        {issueUrl ? (
          <div className="mb-2">
            <OutcomeLink href={issueUrl} label={title ?? issueUrl} />
          </div>
        ) : null}
        <p className="text-paper-300 text-[12px] leading-relaxed whitespace-pre-wrap">
          {truncate(result.description)}
        </p>
      </div>
    );
  }

  return null;
}
