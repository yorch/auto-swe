// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_PLAN_INTENT_MAX_CHARS } from '@/lib/runPlan';
import { RunPlanLauncher } from './RunPlanLauncher';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const JOB = 'runplan-0a1b2c3d-0123456789abcdef';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

type Handler = (body?: unknown) => Response;

function gateway(handlers: Record<string, Handler>) {
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input
          .toString()
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0] ?? '';
      const method = (init?.method ?? 'GET').toUpperCase();
      const key = `${method} ${path}`;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ body, key });
      if (key === 'GET /api/v1/repositories') {
        return json({
          data: [{ id: 'repo-1', organizationName: 'acme', repoName: 'api', type: 'git_repo' }],
          meta: { limit: 500, offset: 0, total: 1 },
        });
      }
      if (key === 'GET /api/v1/run-plans') {
        return json({ data: [], meta: { limit: 20, offset: 0, total: 0 } });
      }
      const handler = handlers[key];
      if (!handler) {
        throw new Error(`unmocked ${key}`);
      }
      return handler(body);
    })
  );
  return calls;
}

function mount(props: Partial<Parameters<typeof RunPlanLauncher>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onLaunched = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <RunPlanLauncher onLaunched={onLaunched} {...props} />
    </QueryClientProvider>
  );
  return onLaunched;
}

describe('RunPlanLauncher', () => {
  it('shows a live counter and refuses an over-length goal without calling the gateway', async () => {
    const calls = gateway({});
    mount();
    const goal = await screen.findByLabelText(/^Goal/);
    fireEvent.change(goal, {
      target: { value: 'x'.repeat(RUN_PLAN_INTENT_MAX_CHARS + 1) },
    });
    expect(screen.getAllByText(/8,001 \/ 8,000/).length).toBeGreaterThan(0);
    const find = screen.getByRole('button', { name: /find matches/i }) as HTMLButtonElement;
    expect(find.disabled).toBe(true);
    fireEvent.click(find);
    expect(calls.some((c) => c.key.includes('/run-plans/route'))).toBe(false);
    expect(screen.getByText(/at most 8,000 characters/)).toBeTruthy();
  });

  it('resumes polling a valid job id, skipping the form, and maps a failure code', async () => {
    gateway({
      [`GET /api/v1/run-plans/jobs/${JOB}`]: () =>
        json({
          data: {
            code: 'PLAN_GENERATION_FAILED',
            message: 'fixed',
            retryable: true,
            status: 'failed',
          },
        }),
    });
    mount({ initialJobId: JOB });
    expect(screen.queryByLabelText(/^Goal/)).toBeNull();
    await screen.findByText('No plan could be generated');
    expect(screen.getByText(/Try rephrasing it/)).toBeTruthy();
  });

  it('opens the preview when a resumed job finishes', async () => {
    gateway({
      [`GET /api/v1/run-plans/jobs/${JOB}`]: () =>
        json({ data: { planId: 'plan-9', status: 'done' } }),
      'GET /api/v1/run-plans/plan-9': () =>
        json({
          data: {
            agentPins: {},
            connectionId: 'repo-1',
            cost: {},
            createdAt: '2026-01-01T00:00:00Z',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            id: 'plan-9',
            intent: 'goal',
            mode: 'output-only',
            nodes: [],
            spec: {},
            status: 'PENDING',
            summary: 's',
            warnings: [],
          },
        }),
    });
    mount({ initialJobId: JOB });
    await screen.findByTestId('plan-preview');
    expect(screen.getByRole('button', { name: /approve & start/i })).toBeTruthy();
  });

  it('opens an existing plan directly, with approval only on the preview', async () => {
    gateway({
      'GET /api/v1/run-plans/plan-7': () =>
        json({
          data: {
            agentPins: {},
            connectionId: 'repo-1',
            cost: {},
            createdAt: '2026-01-01T00:00:00Z',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            id: 'plan-7',
            intent: 'goal',
            mode: 'delivering',
            nodes: [],
            spec: {},
            status: 'PENDING',
            summary: 's',
            warnings: [],
          },
        }),
    });
    mount({ initialPlanId: 'plan-7' });
    expect(screen.queryByLabelText(/^Goal/)).toBeNull();
    await screen.findByTestId('plan-preview');
    expect(screen.getByRole('button', { name: /approve & start/i })).toBeTruthy();
  });

  it('lists ranked matches with a link to the workflow flow and a generate action', async () => {
    gateway({
      'POST /api/v1/run-plans/route': () =>
        json({
          data: {
            matches: [
              {
                description: null,
                name: 'Ticket to merge',
                reason: 'Fits <b>well</b>',
                score: 0.82,
                templateId: 't-1',
              },
            ],
            noneFit: false,
          },
        }),
    });
    mount();
    fireEvent.change(await screen.findByLabelText(/^Goal/), { target: { value: 'do it' } });
    // choose the repository through the combobox
    await waitFor(() => expect(screen.getByRole('combobox', { name: /repository/i })).toBeTruthy());
    const input = screen.getByRole('combobox', { name: /repository/i });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'api' } });
    fireEvent.click(await screen.findByRole('option', { name: /acme\/api/ }));
    fireEvent.click(screen.getByRole('button', { name: /find matches/i }));
    await screen.findByText('Ticket to merge');
    expect(screen.getByText('Fits <b>well</b>')).toBeTruthy();
    const link = screen.getByRole('link', { name: /use this workflow/i });
    expect(link.getAttribute('href')).toBe('/start?mode=workflow&template=t-1&repo=repo-1');
    expect(screen.getByRole('button', { name: /generate a new plan/i })).toBeTruthy();
  });
});
