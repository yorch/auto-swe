// @vitest-environment jsdom
import type { RunActivityItem } from '@auto-swe/shared/types/api';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_LINKER } from '@/lib/traceLinkage';
import { RunActivity } from './RunActivity';

const h = vi.hoisted(() => ({
  data: [] as RunActivityItem[],
  detail: vi.fn(),
  error: null as Error | null,
  export: vi.fn(),
  hook: vi.fn(),
  next: vi.fn(),
}));
vi.mock('@/hooks/useRunActivity', () => ({
  exportRunActivity: h.export,
  useHttpCall: (...args: unknown[]) => {
    h.detail(...args);
    return { data: { requestBody: 'redacted request', responseBody: 'response' } };
  },
  useRunActivity: (...args: unknown[]) => {
    h.hook(...args);
    return { data: h.data, error: h.error, fetchNextPage: h.next, hasNextPage: true };
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.data = [];
  h.error = null;
});
const props = { linker: EMPTY_LINKER, live: true, runId: 'run', selection: null };
async function open() {
  fireEvent.click(screen.getByText('Activity'));
  await screen.findByText('Export activity');
}
describe('RunActivity', () => {
  it('starts collapsed, shows empty results, filters kinds and loads more', async () => {
    render(<RunActivity {...props} />);
    expect(h.hook).not.toHaveBeenCalled();
    await open();
    expect(screen.getByText('No activity matches these filters.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'http call' }));
    expect(h.hook).toHaveBeenLastCalledWith('run', { kinds: 'http_call' }, true);
    fireEvent.click(screen.getByText('Load more activity'));
    expect(h.next).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Export activity'));
    await waitFor(() => expect(h.export).toHaveBeenCalledWith('run', { kinds: 'http_call' }));
  });
  it('shows blocked HTTP metadata and lazily requests bodies', async () => {
    h.data = [
      {
        attempt: 2,
        detail: {
          blocked: true,
          blockReason: 'denied',
          callId: 'call',
          durationMs: 10,
          error: null,
          hasBodies: true,
          host: 'example.com',
          method: 'GET',
          path: '/path',
          port: null,
          purpose: 'other',
          requestBytes: null,
          responseBytes: null,
          scheme: 'https',
          source: 'worker',
          status: 403,
          transcriptId: null,
        },
        id: 'http:call',
        kind: 'http_call',
        recordingId: 'node',
        specNodeId: 'node',
        stepAttempt: 1,
        summary: 'GET example.com/path blocked',
        ts: '2026-01-01T00:00:00Z',
      },
    ];
    render(<RunActivity {...props} />);
    await open();
    expect(h.detail).not.toHaveBeenCalled();
    expect(screen.getByText('Blocked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /GET example.com/ }));
    expect(h.detail).toHaveBeenCalledWith('run', 'call');
    expect(screen.getByText('redacted request')).toBeTruthy();
  });
  it('follows DAG selection and terminal polling state, and renders errors', async () => {
    h.error = new Error('unavailable');
    render(
      <RunActivity
        {...props}
        linker={{
          candidatesByActivity: new Map([['activity', ['node']]]),
          specNodeIds: new Set(['node']),
        }}
        live={false}
        selection="node"
      />
    );
    await open();
    expect(h.hook).toHaveBeenLastCalledWith('run', { specNodeId: 'node' }, false);
    expect(screen.getByText('unavailable')).toBeTruthy();
  });
  it('filters human nodes by spec ID and fan-outs by recording scope', async () => {
    const linker = { candidatesByActivity: new Map(), specNodeIds: new Set(['approval', 'fan']) };
    const { rerender } = render(<RunActivity {...props} linker={linker} selection="approval" />);
    await open();
    expect(h.hook).toHaveBeenLastCalledWith('run', { specNodeId: 'approval' }, true);
    rerender(
      <RunActivity {...props} fanOutNodeIds={new Set(['fan'])} linker={linker} selection="fan" />
    );
    expect(h.hook).toHaveBeenLastCalledWith('run', { recordingId: 'fan' }, true);
  });
});
