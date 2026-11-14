// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportPullRequestOutcomes } from './useTemplates';
import { transcriptExportPath } from './useTranscripts';

afterEach(() => vi.unstubAllGlobals());

describe('exportPullRequestOutcomes', () => {
  it('asks for CSV under the window and repository, and reports a cut-short file', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      new Response('pull_request_id\n', {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'x-export-row-limit': '50000',
          'x-export-truncated': 'true',
        },
        status: 200,
      })
    );
    vi.stubGlobal('fetch', fetchSpy);
    expect(await exportPullRequestOutcomes({ days: 30, kind: 'preset' }, 'repo-1')).toEqual({
      csv: 'pull_request_id\n',
      limit: 50_000,
      truncated: true,
    });
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain('/api/v1/pull-requests/outcomes/export?');
    expect(url).toContain('format=csv');
    expect(url).toContain('window=30');
    expect(url).toContain('repoId=repo-1');
  });
});

describe('transcriptExportPath', () => {
  it('carries the range, format and PII scrub, and drops blank filters', () => {
    const path = transcriptExportPath({
      activityType: ' ',
      agentKey: 'implementer',
      format: 'normalized',
      from: '2026-09-01T00:00:00.000Z',
      scrubPii: true,
      to: '2026-09-08T00:00:00.000Z',
    });
    const qs = new URL(path, 'http://x').searchParams;
    expect(path.startsWith('/api/v1/platform/transcripts/export?')).toBe(true);
    expect(qs.get('format')).toBe('normalized');
    expect(qs.get('scrubPii')).toBe('true');
    expect(qs.get('agentKey')).toBe('implementer');
    expect(qs.has('activityType')).toBe(false);
  });
});
