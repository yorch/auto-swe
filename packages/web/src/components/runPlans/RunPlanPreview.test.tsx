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
    {
      agentRef: 'planner<b>@2</b>',
      feedsImplementer: true,
      id: 'evil',
      inputs: [{ from: 'request.description', key: 'goal' }],
      marker: 'free',
      message: '<u>legacy message</u>',
      region: 'pre',
      step: null,
      type: 'agent',
      writes: ['context.planNotes'],
    },
    { id: 'implement', marker: 'core', region: 'core', step: 'implement', type: 'step' },
    {
      id: 'validate',
      inputs: [
        { from: 'context.ticket', hasDefault: true, key: 'ticket' },
        { from: 'request.description', hasDefault: false, key: 'goal' },
      ],
      marker: 'injected',
      region: 'pre',
      step: 'validateContext',
      type: 'step',
    },
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

function gateway(approve?: () => Response, plan: unknown = PLAN, save?: () => Response) {
  const calls: {
    path: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input
          .toString()
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0] ?? '';
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({
        body: typeof init?.body === 'string' ? init.body : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
        method,
        path,
      });
      if (path === '/api/v1/run-plans/plan-1' && method === 'GET') {
        return json({ data: plan });
      }
      if (path === '/api/v1/repositories') {
        return json({
          data: [{ id: 'repo-1', organizationName: 'acme', repoName: 'api', type: 'git_repo' }],
          meta: { limit: 500, offset: 0, total: 1 },
        });
      }
      if (path === '/api/v1/run-plans/plan-1/save-as-template' && save) {
        return save();
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

  it('says which agent runs on what and that its output feeds the implementer, as text', async () => {
    gateway();
    mount();
    await screen.findByTestId('plan-preview');
    expect(screen.getByTestId('node-action').textContent).toBe(
      'runs agent planner<b>@2</b> on the goal'
    );
    expect(screen.getAllByTestId('feeds-implementer')).toHaveLength(1);
    expect(screen.getByText('Output becomes guidance for the implementer')).toBeTruthy();
    expect(screen.getByText('<u>legacy message</u>')).toBeTruthy();
    // A step names what it reads, and says a fallback exists without showing it.
    expect(screen.getByTestId('node-reads').textContent).toBe(
      'reads ticket from `context.ticket` (has fallback value), goal from the goal'
    );
    expect(document.querySelector('u')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
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

  it('says a scrubbed plan was removed, shows its metadata, and offers no decision or regeneration', async () => {
    const calls = gateway(undefined, {
      ...PLAN,
      approvedAt: '2026-01-01T00:01:00Z',
      intent: '',
      launchedWorkflowRunId: 'run-1',
      nodes: [],
      scrubbed: true,
      scrubbedAt: '2026-06-01T00:00:00Z',
      spec: null,
      specHash: null,
      status: 'LAUNCHED',
      summary: null,
      warnings: [],
    });
    mount();
    await screen.findByTestId('plan-scrubbed');
    expect(
      screen.getByText(
        'The goal and plan body were removed from this plan record after the retention period. The run keeps its own records.'
      )
    ).toBeTruthy();
    expect(screen.getByText('acme/api')).toBeTruthy();
    expect(screen.getByText('anthropic/x')).toBeTruthy();
    expect(screen.getByText('$1.50')).toBeTruthy();
    expect(screen.queryByTestId('plan-preview')).toBeNull();
    expect(screen.queryByTestId('plan-node')).toBeNull();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /regenerate/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
  describe('save as a workflow template', () => {
    const SPEC_PLAN = { ...PLAN, spec: { name: 'Fix the bug', nodes: {} } };
    const openDialog = async () => {
      fireEvent.click(await screen.findByRole('button', { name: /save as workflow template/i }));
      return screen.findByRole('dialog', { hidden: true, name: /save as a workflow template/i });
    };
    const confirmSave = (dialog: HTMLElement) =>
      fireEvent.click(within(dialog).getByRole('button', { name: /save draft/i }));

    it('prefills the name from the spec, saves, and links to the new draft', async () => {
      const calls = gateway(undefined, SPEC_PLAN, () =>
        json(
          { data: { name: 'Fix the bug', status: 'DRAFT', templateId: 'tpl-9', version: 1 } },
          201
        )
      );
      mount();
      const dialog = await openDialog();
      expect((within(dialog).getByLabelText('Template name') as HTMLInputElement).value).toBe(
        'Fix the bug'
      );
      expect(calls.some((c) => c.path.endsWith('/save-as-template'))).toBe(false);
      fireEvent.change(within(dialog).getByLabelText('Template name'), {
        target: { value: 'Bug fixer' },
      });
      confirmSave(dialog);
      const saved = await screen.findByTestId('saved-template');
      expect(saved.querySelector('a')?.getAttribute('href')).toBe('/library/tpl-9');
      expect(saved.textContent).toMatch(/another person must review/i);
      const call = calls.find((c) => c.path.endsWith('/save-as-template'));
      expect(call?.method).toBe('POST');
      expect(JSON.parse(call?.body ?? '{}')).toEqual({ name: 'Bug fixer' });
    });

    it.each([
      [403, 'FORBIDDEN', /only team leads can save templates/i],
      [409, 'NAME_CONFLICT', /choose another name/i],
      [409, 'PLAN_SCRUBBED', /removed after it launched/i],
      [409, 'PLAN_NOT_SAVEABLE', /rejected or expired/i],
    ])('explains a %s %s refusal in the dialog and keeps it open', async (status, code, text) => {
      gateway(undefined, SPEC_PLAN, () =>
        json({ error: { code, message: 'raw gateway text' } }, status)
      );
      mount();
      const dialog = await openDialog();
      confirmSave(dialog);
      const failure = await within(dialog).findByTestId('save-failure');
      expect(failure.textContent).toMatch(text);
      expect(failure.textContent).not.toMatch(/raw gateway text/);
      expect(screen.queryByTestId('saved-template')).toBeNull();
    });

    it.each(['REJECTED', 'EXPIRED'])('offers no save for a %s plan', async (status) => {
      gateway(undefined, { ...SPEC_PLAN, status });
      mount();
      await screen.findByTestId('plan-preview');
      expect(screen.queryByRole('button', { name: /save as workflow template/i })).toBeNull();
    });

    it('offers no save for a scrubbed plan', async () => {
      gateway(undefined, {
        ...SPEC_PLAN,
        intent: '',
        nodes: [],
        scrubbed: true,
        scrubbedAt: '2026-06-01T00:00:00Z',
        spec: null,
        specHash: null,
        status: 'LAUNCHED',
        summary: null,
        warnings: [],
      });
      mount();
      await screen.findByTestId('plan-scrubbed');
      expect(screen.queryByRole('button', { name: /save as workflow template/i })).toBeNull();
    });

    it('offers a save for an approved or launched plan', async () => {
      gateway(undefined, { ...SPEC_PLAN, status: 'LAUNCHED' });
      mount();
      expect(
        await screen.findByRole('button', { name: /save as workflow template/i })
      ).toBeTruthy();
    });
  });
});
