'use client';

import { useState } from 'react';
import type { SecurityEvent, SecurityEventType } from '@/hooks/useAdmin';
import { formatRelativeTime } from '@/lib/utils';

// ── Badge ────────────────────────────────────────────────────────────────────

const EVENT_STYLE: Record<SecurityEventType, { color: string; dot: string; label: string }> = {
  CODE_SECURITY: {
    color: 'bg-dust-400/20 text-dust-400',
    dot: 'bg-dust-400',
    label: 'Code Security',
  },
  CONTENT_SECURITY_BLOCK: {
    color: 'bg-brick-400/20 text-brick-400',
    dot: 'bg-brick-500',
    label: 'Content Block',
  },
  CONTENT_SECURITY_WARN: {
    color: 'bg-amber-400/20 text-amber-400',
    dot: 'bg-amber-400',
    label: 'Content Warn',
  },
  FILE_BLOCK: { color: 'bg-brick-400/20 text-brick-400', dot: 'bg-brick-500', label: 'File Block' },
  LLM_SUSPICIOUS: {
    color: 'bg-violet-400/20 text-violet-400',
    dot: 'bg-violet-400',
    label: 'LLM Suspicious',
  },
  SHELL_BLOCK: {
    color: 'bg-brick-400/20 text-brick-400',
    dot: 'bg-brick-500',
    label: 'Shell Block',
  },
};

export function SecurityEventBadge({ type }: { type: SecurityEventType }) {
  const { color, label } = EVENT_STYLE[type];
  return <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${color}`}>{label}</span>;
}

// ── Detail extraction ─────────────────────────────────────────────────────────

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
    case 'LLM_SUSPICIOUS': {
      const warnings = (output?.warnings as string[]) ?? [];
      return {
        primary: `${warnings.length} pattern${warnings.length !== 1 ? 's' : ''} matched`,
        secondary: warnings.slice(0, 3).join(', ') || undefined,
      };
    }
  }
}

// ── Expanded detail ──────────────────────────────────────────────────────────

function ExpandedDetail({ event }: { event: SecurityEvent }) {
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
            className="font-mono text-[10px] text-paper-300 flex gap-2"
            key={`${f.file}:${f.line}:${f.label}`}
          >
            <span className="text-dust-400 shrink-0">{f.label}</span>
            <span className="text-paper-400">
              {f.file}:{f.line}
            </span>
            <code className="text-paper-500 truncate">{f.match}</code>
          </li>
        ))}
      </ul>
    );
  }

  if (event.eventType === 'LLM_SUSPICIOUS') {
    const warnings = (output?.warnings as string[]) ?? [];
    return (
      <ul className="mt-1.5 space-y-0.5">
        {warnings.map((w) => (
          <li className="font-mono text-[10px] text-violet-300" key={w}>
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
          <li className="font-mono text-[10px] text-paper-300 truncate" key={l}>
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
      <pre className="mt-1.5 font-mono text-[10px] text-paper-300 bg-ink-800 px-2 py-1 rounded overflow-x-auto whitespace-pre-wrap break-all">
        {cmd}
      </pre>
    );
  }

  return null;
}

// ── Event row ────────────────────────────────────────────────────────────────

function SecurityEventRow({ event, showRunLink }: { event: SecurityEvent; showRunLink: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const { primary, secondary } = extractDetail(event);
  const { dot } = EVENT_STYLE[event.eventType];

  return (
    <li>
      <button
        className="w-full text-left rounded hover:bg-ink-800 px-2 py-1.5 transition-colors"
        onClick={() => setExpanded((e) => !e)}
        type="button"
      >
        <div className="flex items-center gap-2 text-xs">
          <span className={`inline-block w-2 h-2 rounded-sm shrink-0 ${dot}`} />
          <SecurityEventBadge type={event.eventType} />
          <span className="font-mono text-paper-200 truncate">{primary}</span>
          {secondary && (
            <span className="font-mono text-paper-500 text-[10px] truncate hidden sm:block">
              {secondary}
            </span>
          )}
          <span className="ml-auto text-[10px] text-paper-500 shrink-0">
            {formatRelativeTime(event.createdAt)}
          </span>
        </div>
        {showRunLink && event.externalTicketId && (
          <div className="flex items-center gap-2 mt-0.5 pl-4">
            <span className="text-[10px] text-paper-500 font-mono">{event.externalTicketId}</span>
            <span className="text-[10px] text-paper-600">·</span>
            <span className="text-[10px] text-paper-500 font-mono">{event.nodeId}</span>
          </div>
        )}
        {expanded && (
          <div className="pl-4">
            <ExpandedDetail event={event} />
          </div>
        )}
      </button>
    </li>
  );
}

// ── Public component ─────────────────────────────────────────────────────────

export function SecurityEventList({
  events,
  emptyMessage = 'No security events recorded.',
  showRunLink = false,
}: {
  emptyMessage?: string;
  events: SecurityEvent[];
  showRunLink?: boolean;
}) {
  if (events.length === 0) {
    return <p className="text-xs text-paper-400 py-1">{emptyMessage}</p>;
  }
  return (
    <ul className="space-y-0.5">
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
  if (trace.error?.startsWith('blocked by shell command')) {
    return 'SHELL_BLOCK';
  }
  if (trace.error?.startsWith('blocked by sensitive file')) {
    return 'FILE_BLOCK';
  }
  if (trace.error?.startsWith('blocked by content security')) {
    return 'CONTENT_SECURITY_BLOCK';
  }
  if (trace.error === 'content security warning') {
    return 'CONTENT_SECURITY_WARN';
  }
  if (trace.type === 'activity_event' && trace.toolName === 'code_security.scan') {
    return 'CODE_SECURITY';
  }
  if (trace.type === 'activity_event' && trace.toolName === 'llm.suspicious_output') {
    return 'LLM_SUSPICIOUS';
  }
  return null;
}
