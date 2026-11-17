// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { RunPlanPreview } from './RunPlanPreview';

beforeEach(stubDialogPrototype);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PLAN = {
  agentKey: null,
  agentPins: { implementer: 'GLOBAL:3' },
  approvedAt: null,
  connectionId: 'repo-1',
  cost: { totalUsd: 1.5, unpriced: [{ nodeId: 'x', reason: 'no-cost-hint' }] },
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  id: 'plan-1',
  intent: 'Fix <b>the bug</b>',
  launchedWorkflowRunId: null,
  mode: 'delivering',
  model: 'anthropic/x',
  nodes: [
    { id: 'evil', marker: 'free', region: 'pre', step: null, type: 'agent' },
    { id: 'implement', marker: 'core', region: 'core', step: 'implement', type: 'step' },
    { id: 'validate', marker: 'injected', region: 'pre', step: 'validateContext', type: 'step' },
  ],
  spec: { nodes: { evil: { label: '<img src=x onerror=alert(1)>' } } },
  specHash: 'h',
  status: 'PENDING',
  summary: 'Does <script>x</script> things',
  teamId: 't',
  warnings: [{ code: 'W1', message: '<i>careful</i>', nodeId: null, source: 'skeleton' }],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

function gateway(approve?: () => Response) {
  const calls: { path: string; method: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input
          .toString()
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0] ?? '';
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ headers: (init?.headers ?? {}) as Record<string, string>, method, path });
      if (path === '/api/v1/run-plans/plan-1' && method === 'GET') {
        return json({ data: PLAN });
      }
      if (path === '/api/v1/repositories') {
        return json({
          data: [{ id: 'repo-1', organizationName: 'acme', repoName: 'api', type: 'git_repo' }],
          meta: { limit: 500, offset: 0, total: 1 },
        });
      }
      if (path === '/api/v1/run-plans/plan-1/approve' && approve) {
        return approve();
      }
      throw new Error(`unmocked ${method} ${path}`);
    })
  );
  return calls;
}

function mount(props: Partial<Parameters<typeof RunPlanPreview>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const handlers = { onApproved: vi.fn(), onBack: vi.fn(), onRegenerate: vi.fn(), ...props };
  render(
    <QueryClientProvider client={qc}>
      <RunPlanPreview planId="plan-1" {...handlers} />
    </QueryClientProvider>
  );
  return handlers;
}

describe('RunPlanPreview', () => {
  it('renders model and user text as plain text, never as markup', async () => {
    gateway();
    mount();
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/Does <script>x<\/script> things/)).toBeTruthy();
    expect(screen.getByText('<i>careful</i>')).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
  });

  it('labels node markers and shows cost, unpriced note and pins', async () => {
    gateway();
    mount();
    await screen.findByTestId('plan-preview');
    expect(screen.getByText('Platform-enforced (cannot be changed)')).toBeTruthy();
    expect(screen.getByText('Added by the platform')).toBeTruthy();
    expect(screen.getByText('Generated for this request')).toBeTruthy();
    expect(screen.getByTestId('plan-cost-total').textContent).toBe('$1.50');
    expect(screen.getByTestId('plan-cost-note').textContent).toMatch(/1 step is unpriced/);
    expect(screen.getByText('GLOBAL:3')).toBeTruthy();
    expect(screen.getByText(/Expires in/)).toBeTruthy();
  });

  it('asks for confirmation naming the repository, delivery and cost before approving', async () => {
    const calls = gateway(() =>
      json({ data: { planId: 'plan-1', temporalWorkflowId: 't', workRequestId: 'wr-9' } }, 201)
    );
    const { onApproved } = mount();
    fireEvent.click(await screen.findByRole('button', { name: /approve & start/i }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    expect(within(dialog).getByText('acme/api')).toBeTruthy();
    expect(within(dialog).getByText(/draft pull request/i)).toBeTruthy();
    expect(within(dialog).getByText(/\$1\.50/)).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/approve'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: /approve and start/i }));
    await waitFor(() => expect(onApproved).toHaveBeenCalledWith('wr-9'));
    const approve = calls.find((c) => c.path.endsWith('/approve'));
    expect(JSON.stringify(approve?.headers)).toMatch(/Idempotency-Key/i);
  });

  it('shows the drift state and withdraws approval when the gateway reports a 409', async () => {
    gateway(() =>
      json(
        {
          error: {
            code: 'PLAN_AGENTS_CHANGED',
            details: { drift: 'agents' },
            message: 'agents changed',
          },
        },
        409
      )
    );
    const { onApproved } = mount();
    fireEvent.click(await screen.findByRole('button', { name: /approve & start/i }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: /approve and start/i }));
    await screen.findByText('This plan is out of date');
    expect(screen.getByText(/Something changed since this plan was made/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve & start/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy();
    expect(onApproved).not.toHaveBeenCalled();
  });
});
