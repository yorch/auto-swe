// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { RunTranscripts } from './RunTranscripts';

const downloadTranscript = vi.fn(async (_id: string, _f: string) => {});
const mutateAsync = vi.fn(async () => ({}));
let admin = false;

const ROW = {
  activityOutcome: 'succeeded',
  activityType: 'executeImplementation',
  agentKeys: ['implementer'],
  attempt: 1,
  closedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  id: 't-1',
  legalHold: false,
  modelCallCount: 7,
  runId: 'r-1',
  runtime: 'claude-code',
  sha256: 'abc',
  sizeBytes: 2048,
  status: 'complete',
  workflowId: 'w-1',
};

vi.mock('@/hooks/useTranscripts', () => ({
  downloadTranscript: (id: string, f: string) => downloadTranscript(id, f),
  useRunTranscripts: () => ({
    data: [ROW],
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useTranscriptLegalHold: () => ({ mutateAsync }),
}));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => admin }));

beforeEach(() => stubDialogPrototype());
afterEach(cleanup);

describe('RunTranscripts', () => {
  it('lists transcripts and the download buttons carry accessible names', async () => {
    render(<RunTranscripts runId="r-1" />);
    expect(screen.getByText('executeImplementation')).toBeTruthy();
    const raw = screen.getByRole('button', {
      name: 'Download raw transcript for executeImplementation attempt 1',
    });
    fireEvent.click(raw);
    expect(downloadTranscript).toHaveBeenCalledWith('t-1', 'raw');
    expect(
      screen.getByRole('button', {
        name: 'Download normalized transcript for executeImplementation attempt 1',
      })
    ).toBeTruthy();
    // Non-admin: no hold toggle.
    expect(screen.queryByRole('button', { name: 'Set legal hold' })).toBeNull();
  });

  it('requires a reason before holding (admin)', async () => {
    admin = true;
    render(<RunTranscripts runId="r-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Set legal hold' }));
    const submit = screen.getByRole('button', { name: 'Set hold' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'litigation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set hold' }));
    expect(mutateAsync).toHaveBeenCalledWith({ held: true, reason: 'litigation' });
  });
});
