// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportAuditLog } from './useAdmin';

afterEach(() => vi.unstubAllGlobals());

function csvResponse(truncated: boolean, limit = '50000') {
  return new Response('time,action\n', {
    headers: {
      'content-type': 'text/csv',
      'x-export-row-limit': limit,
      'x-export-truncated': String(truncated),
    },
    status: 200,
  });
}

describe('exportAuditLog', () => {
  it('reports whether the export was cut short', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(csvResponse(true)));
    expect(await exportAuditLog({} as never)).toEqual({
      csv: 'time,action\n',
      limit: 50_000,
      truncated: true,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(csvResponse(false)));
    expect((await exportAuditLog({} as never)).truncated).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(csvResponse(true, 'nope')));
    expect((await exportAuditLog({} as never)).limit).toBeNull();
  });
});
