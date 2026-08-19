/**
 * Pure data transformation functions for dashboard charts.
 * These operate on the arrays already returned by useWorkflows() / useLessons().
 */

import type { WorkflowSummary } from '@auto-swe/shared/types/api';

type LessonForChart = { failureType: string | null; createdAt: string };

/**
 * `YYYY-MM-DD` for a timestamp, in UTC. Bucket keys and the window below both
 * use UTC so a run can never land on a key the window doesn't contain.
 */
function toDateKey(dateStr: string): string {
  return new Date(dateStr).toISOString().slice(0, 10);
}

/**
 * The trailing `days`-day window, ending today, as UTC date keys.
 *
 * Computed per call rather than once at module load: a dashboard left open
 * across midnight kept bucketing into a stale window, and any run created
 * after the rollover fell outside every bucket and vanished from the chart.
 * Stepping by whole days in UTC also keeps the arithmetic and the keys on one
 * calendar — mixing local `setDate` with UTC `toISOString` shifted every
 * labelled bucket by a day for readers west of UTC.
 */
function lastDays(days: number): string[] {
  const out: string[] = [];
  const todayUtc = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate()
  );
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(todayUtc - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

// ── Workflow transformations ──────────────────────────────────────────

export function groupWorkflowsByStatus(
  workflows: WorkflowSummary[]
): { status: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const w of workflows) {
    const s = w.currentStatus ?? 'UNKNOWN';
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return Object.entries(counts).map(([status, count]) => ({ count, status }));
}

export function groupWorkflowsByDate(
  workflows: WorkflowSummary[],
  days = 30
): { date: string; completed: number; failed: number; active: number }[] {
  const buckets = lastDays(days);
  const map: Record<string, { completed: number; failed: number; active: number }> = {};
  for (const d of buckets) {
    map[d] = { active: 0, completed: 0, failed: 0 };
  }

  for (const w of workflows) {
    const key = toDateKey(w.updatedAt);
    if (!map[key]) {
      continue;
    }
    if (w.currentStatus === 'COMPLETED') {
      map[key].completed++;
    } else if (w.currentStatus === 'FAILED' || w.currentStatus === 'TIMED_OUT') {
      map[key].failed++;
    } else {
      map[key].active++;
    }
  }
  return buckets.map((date) => ({ date, ...map[date] }));
}

export function groupWorkflowsByRepo(
  workflows: WorkflowSummary[]
): { repo: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const w of workflows) {
    const repo = w.repository?.repoName ?? 'Unknown';
    counts[repo] = (counts[repo] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([repo, count]) => ({ count, repo }))
    .sort((a, b) => b.count - a.count);
}

// ── Lesson transformations ────────────────────────────────────────────

export function groupLessonsByType(lessons: LessonForChart[]): { type: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const l of lessons) {
    const t = l.failureType?.replace(/_/g, ' ') ?? 'Unknown';
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([type, count]) => ({ count, type }))
    .sort((a, b) => b.count - a.count);
}

export function groupLessonsByDate(
  lessons: LessonForChart[],
  days = 30
): { date: string; count: number }[] {
  const buckets = lastDays(days);
  const map: Record<string, number> = {};
  for (const d of buckets) {
    map[d] = 0;
  }

  for (const l of lessons) {
    const key = toDateKey(l.createdAt);
    if (map[key] !== undefined) {
      map[key]++;
    }
  }
  return buckets.map((date) => ({ count: map[date], date }));
}
