// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

describe('RunEvidence', () => {
  it('shows evidence metadata and opens screenshots in a lightbox', async () => {
    setupFetchMock({
      'GET /api/v1/workflow-runs/run-1/evidence': () => ({ data: [image] }),
      'POST /api/v1/workflow-runs/run-1/evidence/evidence-1/link': () => ({
        data: { expiresAt: '2026-01-01T00:05:00.000Z', url: '/evidence.png' },
      }),
    });
    render(withQuery(<RunEvidence live={false} runId="run-1" />));
    expect(await screen.findByText('Home page')).toBeTruthy();
    expect(screen.getByText('Node smoke')).toBeTruthy();
    expect(screen.getByText('Attempt 1')).toBeTruthy();
    expect(screen.getByText('Source: uiVerify')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Open screenshot: Home page' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('offers trace help text and requests a download link on demand', async () => {
    setupFetchMock({
      'GET /api/v1/workflow-runs/run-1/evidence': () => ({
        data: [{ ...image, contentType: 'application/zip', id: 'trace-1', kind: 'trace' }],
      }),
      'POST /api/v1/workflow-runs/run-1/evidence/trace-1/link': () => ({
        data: { expiresAt: '2026-01-01T00:05:00.000Z', url: '/trace.zip' },
      }),
    });
    render(withQuery(<RunEvidence live={false} runId="run-1" />));
    expect(await screen.findByText(/npx playwright show-trace/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download trace' })).toBeTruthy();
  });

  it('renders no section when the run has no evidence', async () => {
    setupFetchMock({ 'GET /api/v1/workflow-runs/run-1/evidence': () => ({ data: [] }) });
    const { container } = render(withQuery(<RunEvidence live={false} runId="run-1" />));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.textContent).toBe('');
  });
});
