// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const exportTranscripts = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useTranscripts', () => ({ exportTranscripts }));

import { TranscriptExportModal } from './TranscriptExportModal';

beforeAll(() => stubDialogPrototype());
afterEach(() => {
  cleanup();
  exportTranscripts.mockReset();
});

describe('TranscriptExportModal', () => {
  it('exports the chosen filters over whole UTC days and closes', async () => {
    exportTranscripts.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<TranscriptExportModal onClose={onClose} open />);
    fireEvent.change(screen.getByLabelText('Agent key'), { target: { value: 'implementer' } });
    fireEvent.click(screen.getByLabelText(/Scrub personal data/));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const options = exportTranscripts.mock.calls[0]?.[0];
    expect(options).toMatchObject({ agentKey: 'implementer', format: 'raw', scrubPii: true });
    // A 7-day preset is seven whole UTC days: from midnight to the midnight after today.
    expect(options.from.endsWith('T00:00:00.000Z')).toBe(true);
    expect(Date.parse(options.to) - Date.parse(options.from)).toBe(7 * 86_400_000);
  });

  it('keeps the dialog open and says why when the export fails', async () => {
    exportTranscripts.mockRejectedValue(new Error('range too long'));
    const onClose = vi.fn();
    render(<TranscriptExportModal onClose={onClose} open />);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText('range too long')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
