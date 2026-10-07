'use client';

import {
  MEMORY_SECURITY_EVENTS,
  MEMORY_WRITE_REFUSED_EVENTS,
  SECURITY_TRACE_ERRORS,
} from '@auto-swe/shared/lib/securityTraceTags';
import Link from 'next/link';
import { type ReactNode, useId, useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import type { SecurityEvent, SecurityEventType } from '@/hooks/useAdmin';
import { cn, FOCUS_RING, formatDate, formatRelativeTime } from '@/lib/utils';

// ── Labels ───────────────────────────────────────────────────────────────────

/** Whether a scanner stopped the action or only flagged it. */
export type SecurityEventGroup = 'blocked' | 'advisory';

/**
 * The one place an event type gets its name, colour and group — the filter, the
 * badge and the summary all read it, so they cannot drift apart.
 */
export const SECURITY_EVENT_META: Record<
  SecurityEventType,
  { group: SecurityEventGroup; label: string; tone: BadgeTone }
> = {
  CHANNEL_SUSPICIOUS: { group: 'advisory', label: 'Suspicious channel input', tone: 'violet' },
  CODE_SECURITY: { group: 'advisory', label: 'Code finding', tone: 'dust' },
  CONTENT_SECURITY_BLOCK: { group: 'blocked', label: 'Content blocked', tone: 'brick' },
  CONTENT_SECURITY_WARN: { group: 'advisory', label: 'Content warning', tone: 'amber' },
  FILE_BLOCK: { group: 'blocked', label: 'File write blocked', tone: 'brick' },
  LLM_SUSPICIOUS: { group: 'advisory', label: 'Suspicious model output', tone: 'violet' },
  MEMORY_RECALL_DROPPED: { group: 'blocked', label: 'Memory recall dropped', tone: 'brick' },
  MEMORY_WRITE_REFUSED: { group: 'blocked', label: 'Memory write refused', tone: 'brick' },
  SHELL_BLOCK: { group: 'blocked', label: 'Command blocked', tone: 'brick' },
};

export const SECURITY_EVENT_TYPES = Object.keys(SECURITY_EVENT_META) as SecurityEventType[];

export function securityEventLabel(type: SecurityEventType): string {
  return SECURITY_EVENT_META[type].label;
}

export function SecurityEventBadge({ type }: { type: SecurityEventType }) {
  const { tone, label } = SECURITY_EVENT_META[type];
  return <Badge tone={tone}>{label}</Badge>;
}

// ── Detail extraction ─────────────────────────────────────────────────────────

/** What a refused memory write was, by the event name the worker recorded. */
const MEMORY_WRITE_LABELS: Record<string, string> = {
  [MEMORY_SECURITY_EVENTS.CHANNEL_WRITE_REFUSED]: 'Channel memory',
  [MEMORY_SECURITY_EVENTS.CONSOLIDATION_REFUSED]: 'Consolidated memory',
  [MEMORY_SECURITY_EVENTS.LESSON_REFUSED]: 'Lesson',
};

function extractDetail(event: SecurityEvent): { primary: string; secondary?: string } {
  const input = event.inputJson as Record<string, unknown> | null;
  const output = event.outputJson as Record<string, unknown> | null;

  switch (event.eventType) {
    case 'SHELL_BLOCK': {
      const cmd = String(input?.command ?? '');
      const block = String(output?.output ?? '');
      const label = block.match(/\[([^\]]+)\]/)?.[1] ?? '';
      return {
        primary: cmd.slice(0, 120),
        secondary: label ? `pattern: ${label}` : undefined,
      };
    }
    case 'FILE_BLOCK': {
      const file = String(input?.path ?? '');
      const msg = String(output?.result ?? '');
      const label = msg.match(/\[([^\]]+)\]/)?.[1] ?? '';
      return {
        primary: file,
        secondary: label ? `rule: ${label}` : undefined,
      };
    }
    case 'CONTENT_SECURITY_BLOCK':
    case 'CONTENT_SECURITY_WARN': {
      const file = String(input?.path ?? '');
      const result = String(output?.result ?? '');
      const firstRule = result.match(/\[(CRITICAL|HIGH|MEDIUM)\]\s+(\w+)/)?.[2] ?? '';
      return {
        primary: file,
        secondary: firstRule || undefined,
      };
    }
    case 'CODE_SECURITY': {
      const count = Number(output?.count ?? 0);
      const findings =
        (output?.findings as Array<{ file: string; label: string; line: number }>) ?? [];
      const preview = findings
        .slice(0, 2)
        .map((f) => `${f.label} in ${f.file}:${f.line}`)
        .join(', ');
      return {
        primary: `${count} finding${count !== 1 ? 's' : ''}`,
        secondary: preview || undefined,
      };
    }
    case 'LLM_SUSPICIOUS':
    case 'CHANNEL_SUSPICIOUS': {
      const warnings = (output?.warnings as string[]) ?? [];
      return {
        primary: `${warnings.length} pattern${warnings.length !== 1 ? 's' : ''} matched`,
        secondary: warnings.slice(0, 3).join(', ') || undefined,
      };
    }
    case 'MEMORY_WRITE_REFUSED':
    case 'MEMORY_RECALL_DROPPED': {
      const patterns = (output?.patterns as string[]) ?? [];
      const what =
        event.eventType === 'MEMORY_RECALL_DROPPED'
          ? `${Number(output?.count ?? 0)} recalled item(s) dropped`
          : `${MEMORY_WRITE_LABELS[event.toolName ?? ''] ?? 'Memory write'} refused`;
      return {
        primary: what,
        secondary: patterns.slice(0, 3).join(', ') || undefined,
      };
    }
  }
}

// ── Expanded detail ──────────────────────────────────────────────────────────

/** The expanded view of an event, or null when it has nothing beyond its summary line. */
function expandedDetail(event: SecurityEvent): ReactNode {
  const output = event.outputJson as Record<string, unknown> | null;
  const input = event.inputJson as Record<string, unknown> | null;

  if (event.eventType === 'CODE_SECURITY') {
    const findings =
      (output?.findings as Array<{ file: string; label: string; line: number; match: string }>) ??
      [];
    if (findings.length === 0) {
      return null;
    }
    return (
      <ul className="space-y-1 mt-1.5">
        {findings.map((f) => (
          <li
            className="flex flex-wrap gap-x-2 font-mono text-xs text-paper-300"
            key={`${f.file}:${f.line}:${f.label}`}
          >
            <span className="text-dust-400 shrink-0">{f.label}</span>
            <span className="text-paper-400">
              {f.file}:{f.line}
            </span>
            <code className="break-all text-paper-500">{f.match}</code>
          </li>
        ))}
      </ul>
    );
  }

  if (event.eventType === 'LLM_SUSPICIOUS' || event.eventType === 'CHANNEL_SUSPICIOUS') {
    const warnings = (output?.warnings as string[]) ?? [];
    if (warnings.length === 0) {
      return null;
    }
    return (
      <ul className="mt-1.5 space-y-0.5">
        {warnings.map((w) => (
          <li className="break-words font-mono text-xs text-violet-400" key={w}>
            {w}
          </li>
        ))}
      </ul>
    );
  }

  if (event.eventType === 'CONTENT_SECURITY_BLOCK' || event.eventType === 'CONTENT_SECURITY_WARN') {
    const result = String(output?.result ?? '');
    const relevantLines = result
      .split('\n')
      .filter((l) => l.includes('[CRITICAL]') || l.includes('[HIGH]') || l.includes('[MEDIUM]'))
      .slice(0, 5);
    if (relevantLines.length === 0) {
      return null;
    }
    return (
      <ul className="mt-1.5 space-y-0.5">
        {relevantLines.map((l) => (
          <li className="break-words font-mono text-xs text-paper-300" key={l}>
            {l.trim()}
          </li>
        ))}
      </ul>
    );
  }

  if (event.eventType === 'SHELL_BLOCK') {
    const cmd = String(input?.command ?? '');
    if (!cmd) {
      return null;
    }
    return (
      <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-ink-500 bg-ink-900/70 px-3 py-2 font-mono text-xs text-paper-200">
        {cmd}
      </pre>
    );
  }

  return null;
}

// ── Event row ────────────────────────────────────────────────────────────────

function SecurityEventRow({ event, showRunLink }: { event: SecurityEvent; showRunLink: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const { primary, secondary } = extractDetail(event);
  const detail = expandedDetail(event);
  const summary = (
    <div className="flex min-w-0 items-center gap-2.5 text-xs">
      {detail ? (
        <Icon
          className={cn(
            'shrink-0 text-paper-500 transition-transform',
            expanded && 'rotate-90 text-paper-300'
          )}
          name="chevronRight"
          size={14}
        />
      ) : (
        <span aria-hidden className="w-3.5 shrink-0" />
      )}
      <SecurityEventBadge type={event.eventType} />
      <span className="min-w-0 truncate font-mono text-[13px] text-paper-100">{primary}</span>
      {secondary && (
        <span className="hidden min-w-0 truncate font-mono text-paper-500 sm:block">
          {secondary}
        </span>
      )}
      <time
        className="ml-auto shrink-0 whitespace-nowrap text-paper-500 tabular-nums"
        dateTime={event.createdAt}
        title={formatDate(event.createdAt, { showSeconds: true })}
      >
        {formatRelativeTime(event.createdAt)}
      </time>
    </div>
  );

  return (
    <li className="py-1.5">
      {/* Only a row with more to show is a button: the others have nothing to toggle. */}
      {detail ? (
        <button
          aria-controls={detailId}
          aria-expanded={expanded}
          className={cn(
            'w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-ink-600/40',
            FOCUS_RING
          )}
          onClick={() => setExpanded((e) => !e)}
          type="button"
        >
          {summary}
        </button>
      ) : (
        <div className="px-2 py-1.5">{summary}</div>
      )}
      {/* Outside the button: a link cannot nest inside one. */}
      {showRunLink && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pr-2 pl-8 text-xs">
          {event.runId ? (
            <Link className="text-ember-400 hover:underline" href={`/runs/${event.runId}`}>
              {event.externalTicketId ?? 'view run'}
            </Link>
          ) : (
            // Workflows that keep no run (evals, workflow authoring) have no page to link to.
            <span className="font-mono text-paper-500" title="This workflow keeps no run record">
              {event.workflowId}
            </span>
          )}
          <span aria-hidden className="text-paper-600">
            ·
          </span>
          <span className="font-mono text-paper-500">{event.nodeId}</span>
        </div>
      )}
      {/* A sibling of the toggle, not inside it: content in a <button> is not
          selectable, and block content there is invalid. */}
      {detail && (
        <div className="pr-2 pb-1 pl-8" hidden={!expanded} id={detailId}>
          {expanded && detail}
        </div>
      )}
    </li>
  );
}

// ── Public component ─────────────────────────────────────────────────────────

export function SecurityEventList({
  events,
  emptyHint,
  emptyMessage = 'No security events recorded',
  showRunLink = false,
}: {
  /** A second line under the empty title: why the list is empty, what to try. */
  emptyHint?: ReactNode;
  emptyMessage?: string;
  events: SecurityEvent[];
  showRunLink?: boolean;
}) {
  if (events.length === 0) {
    return <EmptyState hint={emptyHint} icon="security" title={emptyMessage} />;
  }
  return (
    <ul className="divide-y divide-ink-600">
      {events.map((e) => (
        <SecurityEventRow event={e} key={e.id} showRunLink={showRunLink} />
      ))}
    </ul>
  );
}

// ── Client-side classification (for traces already in memory) ─────────────────

export function classifyTraceAsSecurityEvent(trace: {
  error: string | null;
  toolName: string | null;
  type: string;
}): SecurityEventType | null {
  if (trace.error?.startsWith(SECURITY_TRACE_ERRORS.SHELL_BLOCK)) {
    return 'SHELL_BLOCK';
  }
  if (trace.error?.startsWith(SECURITY_TRACE_ERRORS.FILE_BLOCK)) {
    return 'FILE_BLOCK';
  }
  if (trace.error?.startsWith(SECURITY_TRACE_ERRORS.CONTENT_BLOCK)) {
    return 'CONTENT_SECURITY_BLOCK';
  }
  if (trace.error === SECURITY_TRACE_ERRORS.CONTENT_WARN) {
    return 'CONTENT_SECURITY_WARN';
  }
  if (trace.type === 'activity_event' && trace.toolName === 'code_security.scan') {
    return 'CODE_SECURITY';
  }
  if (trace.type === 'activity_event' && trace.toolName === 'llm.suspicious_output') {
    return 'LLM_SUSPICIOUS';
  }
  if (trace.type === 'activity_event' && trace.toolName === 'channel.suspicious_input') {
    return 'CHANNEL_SUSPICIOUS';
  }
  if (trace.type === 'activity_event' && trace.toolName === MEMORY_SECURITY_EVENTS.RECALL_DROPPED) {
    return 'MEMORY_RECALL_DROPPED';
  }
  if (
    trace.type === 'activity_event' &&
    trace.toolName !== null &&
    MEMORY_WRITE_REFUSED_EVENTS.includes(trace.toolName)
  ) {
    return 'MEMORY_WRITE_REFUSED';
  }
  return null;
}
