import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | Date, options?: { showSeconds?: boolean }): string {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    ...(options?.showSeconds ? { second: '2-digit', year: 'numeric' } : {}),
  }).format(new Date(date));
}

export function formatRelativeTime(date: string | Date): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = now - then;

  if (diff < 60_000) {
    return 'just now';
  }
  if (diff < 3600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }
  if (diff < 86400_000) {
    return `${Math.floor(diff / 3600_000)}h ago`;
  }
  return `${Math.floor(diff / 86400_000)}d ago`;
}

export function formatCost(usd: number): string {
  if (usd === 0) {
    return '—';
  }
  if (usd < 0.01) {
    return '<$0.01';
  }
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)}K`;
  }
  return `${n}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) {
    return '—';
  }
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  if (ms < 3_600_000) {
    return `${(ms / 60_000).toFixed(1)}m`;
  }
  return `${(ms / 3_600_000).toFixed(2)}h`;
}

export function formatPercent(p: number | null): string {
  if (p === null) {
    return '—';
  }
  return `${(p * 100).toFixed(1)}%`;
}

// ── Status palette aligned with the Workshop Telemetry design system ────────
type StatusMeta = {
  /** Border + text colour combo for the pill */
  classes: string;
  /** Background colour for the leading status dot */
  dotClass: string;
  /** If true, dot pulses to indicate an in-flight workflow */
  live?: boolean;
};

const MOSS: StatusMeta = {
  classes: 'border-moss-600/40 bg-moss-600/10 text-moss-400',
  dotClass: 'bg-moss-400',
};
const EMBER_LIVE: StatusMeta = {
  classes: 'border-ember-600/40 bg-ember-600/10 text-ember-400',
  dotClass: 'bg-ember-400',
  live: true,
};
const DUST_LIVE: StatusMeta = {
  classes: 'border-dust-600/40 bg-dust-600/10 text-dust-400',
  dotClass: 'bg-dust-400',
  live: true,
};
const AMBER: StatusMeta = {
  classes: 'border-amber-600/40 bg-amber-600/10 text-amber-400',
  dotClass: 'bg-amber-400',
};
const BRICK: StatusMeta = {
  classes: 'border-brick-600/40 bg-brick-600/10 text-brick-400',
  dotClass: 'bg-brick-400',
};
const VIOLET: StatusMeta = {
  classes: 'border-violet-600/40 bg-violet-600/10 text-violet-400',
  dotClass: 'bg-violet-400',
};
const NEUTRAL: StatusMeta = {
  classes: 'border-ink-500 bg-ink-700/40 text-paper-400',
  dotClass: 'bg-paper-500',
};

export const STATUS_META: Record<string, StatusMeta> = {
  // ── WorkflowTemplateStatus ──
  ACTIVE: MOSS,
  ARCHIVED: NEUTRAL,
  // ── ActiveWorkflow.currentStatus ──
  AWAITING_CI: AMBER,
  AWAITING_HUMAN_MERGE: { ...AMBER, dotClass: 'bg-ember-400', live: true },
  // ── WorkflowRunStatus ──
  CANCELLED: NEUTRAL,
  COMPLETED: MOSS,
  DRAFT: AMBER,
  FAILED: BRICK,
  IMPLEMENTING: EMBER_LIVE,
  IN_REVIEW: VIOLET,
  // ── WorkflowStepRecordStatus ──
  PASSED: MOSS,
  PENDING: AMBER,
  RUNNING: DUST_LIVE,
  SKIPPED: NEUTRAL,
  SUCCESS: MOSS,
  TIMED_OUT: NEUTRAL,
  UNKNOWN: NEUTRAL,
  VALIDATING_CONTEXT: EMBER_LIVE,
};
