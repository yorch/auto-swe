// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

// Answers as the gateway does: a link for exactly the transcript, format and PII choice asked for.
const post = vi.fn(async (path: string, body: unknown) => {
  const id = path.split('/')[4];
  const { format, scrubPii } = body as { format: string; scrubPii: boolean };
  return {
    expiresAt: '2026-01-01T00:01:00.000Z',
    url: `/api/v1/transcripts/${id}/content?format=${format}&scrubPii=${scrubPii}&dl=tok.sig`,
  };
});

vi.mock('@/lib/api', () => ({
  api: { post: (path: string, body: unknown) => post(path, body) },
}));
vi.mock('@/lib/config', () => ({ API_BASE: 'https://gw.example' }));

import { downloadTranscript } from './useTranscripts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('downloadTranscript', () => {
  it('asks the gateway for a signed link, then lets the browser navigate to it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const createObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push(this.href);
    });

    await downloadTranscript('t-1', 'normalized');

    expect(post).toHaveBeenCalledWith('/api/v1/transcripts/t-1/download-link', {
      format: 'normalized',
      scrubPii: false,
    });
    expect(clicked).toEqual([
      'https://gw.example/api/v1/transcripts/t-1/content?format=normalized&scrubPii=false&dl=tok.sig',
    ]);
    // The body never passes through the page: no fetch of the content, no blob.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    // The temporary anchor is removed again.
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('carries format and scrubPii through to the navigated link', async () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push(this.href);
    });

    await downloadTranscript('t-9', 'normalized', { scrubPii: true });

    expect(post).toHaveBeenLastCalledWith('/api/v1/transcripts/t-9/download-link', {
      format: 'normalized',
      scrubPii: true,
    });
    expect(clicked).toEqual([
      'https://gw.example/api/v1/transcripts/t-9/content?format=normalized&scrubPii=true&dl=tok.sig',
    ]);
  });

  it('surfaces a refused link request and navigates nowhere', async () => {
    post.mockRejectedValueOnce(new Error('HTTP 404'));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    await expect(downloadTranscript('t-1', 'raw')).rejects.toThrow('HTTP 404');
    expect(click).not.toHaveBeenCalled();
  });
});
