import { ApiError } from '@/lib/api';
import { downloadFile } from '@/lib/downloadFile';

/** The query the people table is showing, so the file holds the same rows in the same order. */
export interface PeopleExportParams {
  days: number;
  order: 'asc' | 'desc';
  q?: string;
  sort: string;
}

/** Save every person matching the current search and sort (not just the visible page) as a CSV. */
export function downloadCsv({ days, order, q, sort }: PeopleExportParams): Promise<void> {
  const qs = new URLSearchParams({ days: String(days), order, sort });
  if (q) {
    qs.set('q', q);
  }
  return downloadFile(
    `/api/v1/platform/analytics/users/export?${qs}`,
    `user-analytics-${days}d.csv`
  );
}

/** What to tell the admin when the export fails: the gateway's own words for a too-large result. */
export function exportErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 413 && err.message) {
    return err.message;
  }
  return 'Export failed';
}
