// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

import GovernAssistantFailuresPage from './page';

beforeEach(() => resetNavigation('', '/govern/assistant'));
afterEach(() => vi.unstubAllGlobals());

const FAILURE = {
  conversationId: 'conv-1',
  createdAt: '2026-10-14T10:00:00.000Z',
  error: 'I hit an error answering that. Please try again.',
  errorDetail: 'ConfigMissingError: no ProviderCredential for anthropic',
  failedAt: '2026-10-14T10:00:02.000Z',
  id: 'msg-1',
  user: { email: 'ada@example.com', id: 'user-1', name: 'Ada Lovelace' },
  workflowId: 'assistant-conv-1',
};

function mock(total = 1) {
  return setupFetchMock({
    'GET /api/v1/platform/assistant/failures': () => ({
      data: total ? [FAILURE] : [],
      meta: { limit: 50, offset: 0, total },
    }),
    'GET /api/v1/platform/assistant/failures/msg-1': () => ({
      data: {
        ...FAILURE,
        traces: [
          {
            agentKey: 'appAssistant',
            attempt: 1,
            costUsd: null,
            createdAt: '2026-10-14T10:00:01.000Z',
            durationMs: 640,
            error: 'gateway answered 500',
            id: 't1',
            inputTokens: null,
            model: null,
            otelTraceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            outputTokens: null,
            toolName: 'callApi',
            type: 'tool_call',
          },
        ],
      },
    }),
  });
}

describe('GovernAssistantFailuresPage', () => {
  it('lists each failure with who it failed for and the recorded cause', async () => {
    mock();
    render(withQuery(<GovernAssistantFailuresPage />));

    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    expect(screen.getByText(FAILURE.errorDetail)).toBeTruthy();
    expect(screen.getByText(`Shown to the user: ${FAILURE.error}`)).toBeTruthy();
  });

  it("loads a failure's trace rows only once it is expanded", async () => {
    const spy = mock();
    render(withQuery(<GovernAssistantFailuresPage />));
    await screen.findByText('Ada Lovelace');
    const detailCalls = () =>
      spy.mock.calls.filter(([u]) => String(u).includes('/failures/msg-1')).length;
    expect(detailCalls()).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: /Ada Lovelace/ }));

    expect(await screen.findByText('gateway answered 500')).toBeTruthy();
    expect(screen.getByText('callApi')).toBeTruthy();
    expect(screen.getByText('assistant-conv-1')).toBeTruthy();
    expect(screen.getByText('4bf92f3577b34da6a3ce929d0e0e4736')).toBeTruthy();
    await waitFor(() => expect(detailCalls()).toBe(1));
  });

  it('says so when nothing failed in the range', async () => {
    mock(0);
    render(withQuery(<GovernAssistantFailuresPage />));
    expect(await screen.findByText('No assistant failures in this range')).toBeTruthy();
  });
});
