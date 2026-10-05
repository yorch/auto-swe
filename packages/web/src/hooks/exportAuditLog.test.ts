// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportAuditLog } from './useAdmin';

afterEach(() => vi.unstubAllGlobals());

function csvResponse(truncated: boolean) {
  return new Response('time,action\n', {
    headers: { 'content-type': 'text/csv', 'x-export-truncated': String(truncated) },
    status: 200,
  });
}

describe('exportAuditLog', () => {
  it('reports whether the export was cut short', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(csvResponse(true)));
    expect(await exportAuditLog({} as never)).toEqual({ csv: 'time,action\n', truncated: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(csvResponse(false)));
    expect((await exportAuditLog({} as never)).truncated).toBe(false);
  });
});
