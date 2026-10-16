// @vitest-environment jsdom

import type { AssistantConversationSummary } from '@auto-swe/shared/lib/assistantConversation';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { type AssistantConversationDetail, useResetAssistantTitle } from './useAssistant';

const ID = 'conv-1';
const summary = (overrides: Partial<AssistantConversationSummary>) => ({
  createdAt: '2026-10-16T10:00:00Z',
  id: ID,
  title: 'My name for it',
  titleSource: 'USER' as const,
  updatedAt: '2026-10-16T10:00:00Z',
  ...overrides,
});

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData<AssistantConversationDetail>(['assistant', 'conversation', ID], {
    conversation: summary({}),
    messages: [],
  });
  qc.setQueryData(['assistant', 'conversations'], [summary({})]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const title = () =>
  qc.getQueryData<AssistantConversationDetail>(['assistant', 'conversation', ID])?.conversation
    .title;

describe('useResetAssistantTitle', () => {
  it("shows the first message's title at once, then the model's when it is written", async () => {
    let reads = 0;
    setupFetchMock({
      [`GET /api/v1/assistant/conversations/${ID}`]: () => {
        reads += 1;
        return {
          data: {
            conversation:
              reads < 2
                ? summary({ title: 'hi', titleSource: 'FIRST_MESSAGE' })
                : summary({ title: 'Connecting the GitHub App', titleSource: 'MODEL' }),
            messages: [],
          },
        };
      },
      [`POST /api/v1/assistant/conversations/${ID}/title/reset`]: () => ({
        data: {
          conversation: summary({ title: 'hi', titleSource: 'FIRST_MESSAGE' }),
          naming: true,
        },
      }),
    });
    const { result } = renderHook(() => useResetAssistantTitle(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(ID);
    });
    expect(title()).toBe('hi');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(reads).toBe(2);
    expect(title()).toBe('Connecting the GitHub App');
    const list = qc.getQueryData<AssistantConversationSummary[]>(['assistant', 'conversations']);
    expect(list?.[0]?.title).toBe('Connecting the GitHub App');

    // Named: it stops looking.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(reads).toBe(2);
  });

  it('does not look again when the model was not asked', async () => {
    const fetchSpy = setupFetchMock({
      [`POST /api/v1/assistant/conversations/${ID}/title/reset`]: () => ({
        data: {
          conversation: summary({ title: 'hi', titleSource: 'FIRST_MESSAGE' }),
          naming: false,
        },
      }),
    });
    const { result } = renderHook(() => useResetAssistantTitle(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(ID);
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(title()).toBe('hi');
  });

  it('gives up after its last try when the model declines', async () => {
    let reads = 0;
    setupFetchMock({
      [`GET /api/v1/assistant/conversations/${ID}`]: () => {
        reads += 1;
        return {
          data: {
            conversation: summary({ title: 'hi', titleSource: 'FIRST_MESSAGE' }),
            messages: [],
          },
        };
      },
      [`POST /api/v1/assistant/conversations/${ID}/title/reset`]: () => ({
        data: {
          conversation: summary({ title: 'hi', titleSource: 'FIRST_MESSAGE' }),
          naming: true,
        },
      }),
    });
    const { result } = renderHook(() => useResetAssistantTitle(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(ID);
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(reads).toBe(8);
  });
});
