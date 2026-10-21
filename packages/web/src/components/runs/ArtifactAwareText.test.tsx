// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ArtifactAwareText, splitArtifactMarkers } from './ArtifactAwareText';

const RUN = '6f9619ff-8b86-4a08-8b86-3e6f9619ffd1';
const A = '7a9619ff-8b86-4a08-8b86-3e6f9619ffd2';
const B = '8b9619ff-8b86-4a08-8b86-3e6f9619ffd3';
const marker = (id: string, bytes: number) => `[stored as artifact ${id} — ${bytes} bytes]`;

// jsdom implements <dialog> without showModal()/close().
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(respond: (url: string) => Response) {
  const spy = vi.fn(async (input: RequestInfo | URL) => respond(String(input)));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function renderText(text: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ArtifactAwareText runId={RUN} text={text} />
    </QueryClientProvider>
  );
}

describe('splitArtifactMarkers', () => {
  it('returns one text part when there is no marker', () => {
    expect(splitArtifactMarkers('plain result')).toEqual([{ kind: 'text', value: 'plain result' }]);
  });

  it('finds several markers with the text around them', () => {
    expect(splitArtifactMarkers(`a ${marker(A, 5000)} b ${marker(B, 12)}`)).toEqual([
      { kind: 'text', value: 'a ' },
      { artifactId: A, kind: 'marker', sizeBytes: 5000 },
      { kind: 'text', value: ' b ' },
      { artifactId: B, kind: 'marker', sizeBytes: 12 },
    ]);
  });

  it('leaves a marker with a malformed id as text', () => {
    const bad = '[stored as artifact not-a-uuid — 10 bytes]';
    expect(splitArtifactMarkers(bad)).toEqual([{ kind: 'text', value: bad }]);
  });

  it('leaves a marker written with a hyphen instead of the em dash as text', () => {
    const bad = `[stored as artifact ${A} - 10 bytes]`;
    expect(splitArtifactMarkers(bad)).toEqual([{ kind: 'text', value: bad }]);
  });
});

describe('ArtifactAwareText', () => {
  it('renders plain text with no button and fires no request', () => {
    const spy = stubFetch(() => json({}));
    renderText('just words');
    expect(screen.getByText('just words')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('offers one button per marker and fetches nothing until one is opened', () => {
    const spy = stubFetch(() => json({ data: { sizeBytes: 5, text: 'x' } }));
    renderText(`first ${marker(A, 5000)} then ${marker(B, 7)}`);
    expect(screen.getByRole('button', { name: 'View full text (5,000 bytes)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View full text (7 bytes)' })).toBeTruthy();
    expect(screen.getByText(/first/)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches the marker’s artifact for this run on open and shows the text', async () => {
    const spy = stubFetch(() => json({ data: { sizeBytes: 11, text: 'full output\nline 2' } }));
    renderText(marker(A, 11));
    fireEvent.click(screen.getByRole('button', { name: /View full text/ }));
    await waitFor(() => expect(screen.getByText(/full output/)).toBeTruthy());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain(`/api/v1/workflow-runs/${RUN}/artifacts/${A}`);
  });

  it('shows an error when the artifact cannot be loaded', async () => {
    stubFetch(() =>
      json({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found' } }, 404)
    );
    renderText(marker(A, 11));
    fireEvent.click(screen.getByRole('button', { name: /View full text/ }));
    await waitFor(() => expect(screen.getByText(/Artifact not found/)).toBeTruthy());
  });

  it('renders fetched HTML as text, never as markup', async () => {
    const payload = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    stubFetch(() => json({ data: { sizeBytes: payload.length, text: payload } }));
    renderText(marker(A, payload.length));
    fireEvent.click(screen.getByRole('button', { name: /View full text/ }));
    await waitFor(() => expect(screen.getByText(payload, { exact: false })).toBeTruthy());
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });
});
