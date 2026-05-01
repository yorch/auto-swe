/**
 * Pure data transformation functions for dashboard charts.
 * These operate on the arrays already returned by useWorkflows() / useLessons().
 */

import type { WorkflowSummary, LessonListItem } from '@auto-swe/shared/types/api';

const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'TIMED_OUT'];

function toDateKey(dateStr: string): string {
  return new Date(dateStr).toISOString().slice(0, 10); // YYYY-MM-DD
}

function last30Days(): string[] {
  const days: string[] = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

// ── Workflow transformations ──────────────────────────────────────────

export function groupWorkflowsByStatus(
  workflows: WorkflowSummary[],
): { status: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const w of workflows) {
    const s = w.currentStatus ?? 'UNKNOWN';
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return Object.entries(counts).map(([status, count]) => ({ status, count }));
}

export function groupWorkflowsByDate(
  workflows: WorkflowSummary[],
  days = 30,
): { date: string; completed: number; failed: number; active: number }[] {
  const buckets = last30Days().slice(-days);
  const map: Record<string, { completed: number; failed: number; active: number }> = {};
  for (const d of buckets) map[d] = { completed: 0, failed: 0, active: 0 };

  for (const w of workflows) {
    const key = toDateKey(w.updatedAt);
    if (!map[key]) continue;
    if (w.currentStatus === 'COMPLETED') map[key].completed++;
    else if (w.currentStatus === 'FAILED' || w.currentStatus === 'TIMED_OUT') map[key].failed++;
    else map[key].active++;
  }
  return buckets.map((date) => ({ date, ...map[date] }));
}

export function groupWorkflowsByRepo(
  workflows: WorkflowSummary[],
): { repo: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const w of workflows) {
    const repo = w.repository?.repoName ?? 'Unknown';
    counts[repo] = (counts[repo] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([repo, count]) => ({ repo, count }))
    .sort((a, b) => b.count - a.count);
}

// ── Lesson transformations ────────────────────────────────────────────

export function groupLessonsByType(
  lessons: LessonListItem[],
): { type: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const l of lessons) {
    const t = l.failureType?.replace(/_/g, ' ') ?? 'Unknown';
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

export function groupLessonsByDate(
  lessons: LessonListItem[],
  days = 30,
): { date: string; count: number }[] {
  const buckets = last30Days().slice(-days);
  const map: Record<string, number> = {};
  for (const d of buckets) map[d] = 0;

  for (const l of lessons) {
    const key = toDateKey(l.createdAt);
    if (map[key] !== undefined) map[key]++;
  }
  return buckets.map((date) => ({ date, count: map[date] }));
}
