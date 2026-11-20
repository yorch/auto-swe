import { afterEach, describe, expect, it, vi } from 'vitest';

const downloadFile = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/downloadFile', () => ({ downloadFile: (...a: unknown[]) => downloadFile(...a) }));

import { ApiError } from '@/lib/api';
import { downloadCsv, exportErrorMessage } from './exportCsv';

afterEach(() => downloadFile.mockClear());

describe('downloadCsv', () => {
  it('passes the table query and names the file by window', async () => {
    await downloadCsv({ days: 7, order: 'asc', q: 'a&b', sort: 'email' });
    expect(downloadFile).toHaveBeenCalledWith(
      '/api/v1/platform/analytics/users/export?days=7&order=asc&sort=email&q=a%26b',
      'user-analytics-7d.csv'
    );
  });

  it('leaves out an empty search', async () => {
    await downloadCsv({ days: 14, order: 'desc', sort: 'lastActive' });
    expect(downloadFile.mock.calls[0]?.[0]).not.toContain('q=');
  });
});

describe('exportErrorMessage', () => {
  it('shows the gateway message for a too-large export', () => {
    const e = new ApiError('Narrow the search with q', 413, 'EXPORT_TOO_LARGE');
    expect(exportErrorMessage(e)).toBe('Narrow the search with q');
  });

  it('falls back for anything else', () => {
    expect(exportErrorMessage(new ApiError('boom', 500, null))).toBe('Export failed');
    expect(exportErrorMessage(new Error('x'))).toBe('Export failed');
  });
});
