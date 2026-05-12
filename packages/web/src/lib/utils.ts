import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  }).format(new Date(date));
}

export function formatRelativeTime(date: string | Date): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = now - then;

  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return '—';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(2)}h`;
}

export function formatPercent(p: number | null): string {
  if (p === null) return '—';
  return `${(p * 100).toFixed(1)}%`;
}

export const STATUS_COLORS: Record<string, string> = {
  // ── WorkflowTemplateStatus ──
  ACTIVE: 'bg-green-100 text-green-800',
  ARCHIVED: 'bg-gray-100 text-gray-800',
  // ── ActiveWorkflow.currentStatus ──
  AWAITING_CI: 'bg-yellow-100 text-yellow-800',
  AWAITING_HUMAN_MERGE: 'bg-orange-100 text-orange-800',
  // ── WorkflowRunStatus ──
  CANCELLED: 'bg-gray-100 text-gray-800',
  COMPLETED: 'bg-green-100 text-green-800',
  DRAFT: 'bg-yellow-100 text-yellow-800',
  FAILED: 'bg-red-100 text-red-800',
  IMPLEMENTING: 'bg-blue-100 text-blue-800',
  IN_REVIEW: 'bg-purple-100 text-purple-800',
  // ── WorkflowStepRecordStatus (PASSED unique to step rows; others shared) ──
  PASSED: 'bg-green-100 text-green-800',
  PENDING: 'bg-purple-100 text-purple-800',
  RUNNING: 'bg-blue-100 text-blue-800',
  SKIPPED: 'bg-gray-100 text-gray-700',
  SUCCESS: 'bg-green-100 text-green-800',
  TIMED_OUT: 'bg-gray-100 text-gray-800',
  VALIDATING_CONTEXT: 'bg-indigo-100 text-indigo-800',
};
