// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MyPlans } from './MyPlans';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = (over: Record<string, unknown>) => ({
  agentKey: null,
  connectionId: 'repo-1',
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-01-01T01:00:00Z',
  id: 'p',
  intent: '',
  mode: 'delivering',
  status: 'LAUNCHED',
  teamId: 't',
  totalUsd: 1,
  ...over,
});

function mount(rows: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: rows, meta: { limit: 20, offset: 0, total: rows.length } }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          }
        )
    )
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MyPlans onOpen={vi.fn()} />
    </QueryClientProvider>
  );
}

describe('MyPlans', () => {
  it('marks a scrubbed plan instead of showing an empty goal, and still lists it', async () => {
    mount([
      item({ id: 'a', intent: 'Fix the login bug', scrubbed: false }),
      item({ id: 'b', scrubbed: true }),
    ]);
    await screen.findByText('Fix the login bug');
    const marks = screen.getAllByTestId('plan-scrubbed');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe('The goal and plan were removed after the retention period');
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(2);
  });
});
