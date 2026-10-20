// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

const getToken = vi.fn((): string | null => 'tok-123');
const fetchMock = vi.fn(async () => new Response(new Blob(['line'])) as Response);
const createObjectURL = vi.fn(() => 'blob:fake');
const revokeObjectURL = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { getToken: () => getToken() },
}));
vi.mock('@/lib/config', () => ({ API_BASE: 'https://gw.example' }));

import { downloadTranscript } from './useTranscripts';

describe('downloadTranscript', () => {
  it('sends the bearer token when one exists', async () => {
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const click = vi.fn();
    vi.spyOn(document, 'createElement').mockReturnValue({
      click,
      download: '',
      set href(_v: string) {},
    } as unknown as HTMLAnchorElement);
    await downloadTranscript('t-1', 'raw');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gw.example/api/v1/transcripts/t-1/content?format=raw',
      expect.objectContaining({
        credentials: 'include',
        headers: { Authorization: 'Bearer tok-123' },
      })
    );
  });

  it('omits Authorization when there is no token', async () => {
    getToken.mockReturnValueOnce(null);
    await downloadTranscript('t-1', 'normalized');
    const call = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect((call[1].headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });
});
