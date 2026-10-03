// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import GovernSecurityPage from './page';

afterEach(() => vi.unstubAllGlobals());

function event(i: number) {
  return {
    createdAt: '2026-09-01T00:00:00.000Z',
    error: 'blocked by shell command scanner',
    eventType: 'SHELL_BLOCK',
    externalTicketId: null,
    id: `ev-${i}`,
    inputJson: { command: `curl evil-${i}` },
    nodeId: 'executeImplementation',
    outputJson: {},
    runId: null,
    startedAt: null,
    toolName: 'bash',
    workflowId: 'wf-1',
    workRequestId: null,
  };
}

function mock() {
  return setupFetchMock({
    'GET /api/v1/platform/security-events': () => ({
      // Only one event on this page, but 120 recorded in total.
      data: [event(1)],
      meta: { limit: 50, offset: 0, total: 120 },
    }),
    'GET /api/v1/platform/security-events/summary': () => ({
      data: {
        CHANNEL_SUSPICIOUS: 0,
        CODE_SECURITY: 0,
        CONTENT_SECURITY_BLOCK: 0,
        CONTENT_SECURITY_WARN: 0,
        FILE_BLOCK: 3,
        LLM_SUSPICIOUS: 0,
        SHELL_BLOCK: 117,
      },
    }),
  });
}

const urls = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map(([u]) => String(u));

describe('GovernSecurityPage', () => {
  it('takes per-type counts from the server summary, not the page on screen', async () => {
    mock();
    render(withQuery(<GovernSecurityPage />));

    expect(await screen.findByText('117')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('· 120')).toBeTruthy();
  });

  it('pages through events with the shared pagination control', async () => {
    const spy = mock();
    render(withQuery(<GovernSecurityPage />));
    await screen.findByText('1–50 of 120');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() =>
      expect(urls(spy).some((u) => u.includes('security-events?') && u.includes('offset=50'))).toBe(
        true
      )
    );
  });
});
