// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE } from '@/lib/config';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { RunEvidence } from './RunEvidence';

const image: Record<string, unknown> = {
  caption: 'Home page',
  contentType: 'image/png',
  createdAt: '2026-01-01T00:00:00.000Z',
  height: 480,
  id: 'evidence-1',
  kind: 'screenshot',
  pageUrl: 'http://localhost:3000/',
  sizeBytes: 12,
  source: 'uiVerify',
  specNodeId: 'smoke',
  stepAttempt: 1,
  width: 640,
};

function setupEvidenceFetch(data: Record<string, unknown>[]) {
  const handlers: Record<string, () => unknown> = {
    'GET /api/v1/workflow-runs/run-1/evidence': () => ({ data }),
  };
  for (const item of data) {
    handlers[`POST /api/v1/workflow-runs/run-1/evidence/${item.id}/link`] = () => ({
      data: { expiresAt: '2026-01-01T00:05:00.000Z', url: '/evidence.png' },
    });
  }
  return setupFetchMock(handlers);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

describe('RunEvidence', () => {
  it('keeps the viewer and browser executor on the same pinned Playwright version', async () => {
    const [webPackage, browserDockerfile] = await Promise.all([
      readFile(resolve(process.cwd(), 'packages/web/package.json'), 'utf8'),
      readFile(resolve(process.cwd(), 'defaults/Dockerfile.node-browser'), 'utf8'),
    ]);
    const webVersion = (JSON.parse(webPackage) as { devDependencies: Record<string, string> })
      .devDependencies['playwright-core'];
    const imageVersion = browserDockerfile.match(/playwright@(\d+\.\d+\.\d+)/)?.[1];

    expect(webVersion).toBe('1.64.1');
    expect(imageVersion).toBe(webVersion);
  });

  it('is collapsed without minting links, then opens screenshots in a lightbox', async () => {
    const fetchSpy = setupEvidenceFetch([image]);
    render(withQuery(<RunEvidence live={false} runId="run-1" />));
    const summary = await screen.findByText('Evidence', { selector: 'summary' });
    const details = summary.closest('details');
    expect(details?.open).toBe(false);
    expect(screen.queryByText('Home page')).toBeNull();
    expect(
      fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    ).toHaveLength(0);

    fireEvent.click(summary);
    expect(await screen.findByRole('button', { name: 'Open screenshot: Home page' })).toBeTruthy();
    expect(screen.getByText('Node smoke')).toBeTruthy();
    expect(screen.getByText('Attempt 1')).toBeTruthy();
    expect(screen.getByText('Source: uiVerify')).toBeTruthy();
    expect(
      fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    ).toHaveLength(1);
    fireEvent.click(await screen.findByRole('button', { name: 'Open screenshot: Home page' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('shows a count for each nonempty evidence kind', async () => {
    const evidence = [
      image,
      { ...image, id: 'screenshot-2' },
      { ...image, id: 'screenshot-3' },
      { ...image, contentType: 'video/webm', id: 'video-1', kind: 'video' },
      { ...image, contentType: 'application/zip', id: 'trace-1', kind: 'trace' },
      { ...image, contentType: 'text/plain; charset=utf-8', id: 'log-1', kind: 'log' },
    ];
    setupEvidenceFetch(evidence);
    render(withQuery(<RunEvidence live={false} runId="run-1" />));
    expect(await screen.findByText('3 screenshots, 1 video, 1 trace, 1 log')).toBeTruthy();
  });

  it('opens automatically when the page is loaded with the evidence hash', async () => {
    window.history.replaceState({}, '', '/runs/run-1#evidence');
    setupEvidenceFetch([image]);
    render(withQuery(<RunEvidence live={false} runId="run-1" />));
    const summary = await screen.findByText('Evidence', { selector: 'summary' });
    await waitFor(() => expect(summary.closest('details')?.open).toBe(true));
    expect(await screen.findByRole('button', { name: 'Open screenshot: Home page' })).toBeTruthy();
  });

  it('opens when the evidence hash changes', async () => {
    setupEvidenceFetch([image]);
    render(withQuery(<RunEvidence live={false} runId="run-1" />));
    const summary = await screen.findByText('Evidence', { selector: 'summary' });
    const details = summary.closest('details');
    expect(details?.open).toBe(false);
    window.history.replaceState({}, '', '/runs/run-1#evidence');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => expect(details?.open).toBe(true));
  });

  it('offers trace help text and a download button when expanded', async () => {
    setupEvidenceFetch([
      { ...image, contentType: 'application/zip', id: 'trace-1', kind: 'trace' },
    ]);
    render(withQuery(<RunEvidence live={false} runId="run-1" />));
    fireEvent.click(await screen.findByText('Evidence', { selector: 'summary' }));
    expect(await screen.findByText(/npx playwright show-trace/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download trace' })).toBeTruthy();
  });

  it('opens a trace in the dashboard viewer using a freshly minted absolute link', async () => {
    const fetchSpy = setupEvidenceFetch([
      { ...image, contentType: 'application/zip', id: 'trace-1', kind: 'trace' },
    ]);
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(withQuery(<RunEvidence live={false} runId="run-1" />));
    fireEvent.click(await screen.findByText('Evidence', { selector: 'summary' }));

    const openViewer = await screen.findByRole('button', { name: 'Open trace viewer' });
    const postRequests = () =>
      fetchSpy.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
      );
    await waitFor(() => expect(postRequests()).toHaveLength(1));
    fireEvent.click(openViewer);

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const traceUrl = new URL(`${API_BASE}/evidence.png`, window.location.href).toString();
    expect(open).toHaveBeenCalledWith(
      `/trace-viewer/index.html?trace=${encodeURIComponent(traceUrl)}`,
      '_blank',
      'noopener'
    );
    expect(postRequests()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Download trace' })).toBeTruthy();
    expect(screen.getByText(/npx playwright show-trace/)).toBeTruthy();
  });

  it('renders no section when the run has no evidence', async () => {
    const fetchSpy = setupEvidenceFetch([]);
    const { container } = render(withQuery(<RunEvidence live={false} runId="run-1" />));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
