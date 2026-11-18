// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, withQuery } from '@/test/rtl-helpers';

const push = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ role: 'ENGINEER' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: { role: string } | null }) => unknown) =>
    selector({ user: { role: auth.role } }),
}));

import { OrchestrateForm } from './OrchestrateForm';

const AGENTS = [
  {
    description: 'Reads code',
    key: 'researcher',
    name: 'Researcher',
    pinnableVersions: [],
    scope: 'GLOBAL',
    version: 1,
  },
  {
    description: null,
    key: 'writer',
    name: 'Writer',
    pinnableVersions: [],
    scope: 'GLOBAL',
    version: 1,
  },
];

function gateway(
  options: {
    teams?: { id: string; name: string }[];
    launchStatus?: number;
    connections?: { id: string; name: string }[];
    platformConnections?: unknown[];
    defaults?: string[];
    defaultsWriteCapable?: string[];
  } = {}
) {
  const teams = options.teams ?? [{ id: 't1', name: 'Payments' }];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input
      .toString()
      .replace(/^https?:\/\/[^/]+/, '')
      .split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    if (path === '/api/v1/teams') {
      return json({ data: teams.map((t) => ({ ...t, myRole: 'ENGINEER', slug: t.name })) });
    }
    if (path === '/api/v1/repositories') {
      return json({ data: [], meta: { limit: 500, offset: 0, total: 0 } });
    }
    if (path === '/api/v1/platform/mcp-connections') {
      return json({ data: options.platformConnections ?? [] });
    }
    if (path === '/api/v1/orchestrations/connections') {
      return json({ data: options.connections ?? [] });
    }
    if (path === '/api/v1/orchestrations/defaults') {
      return json({
        data: {
          allowlist: options.defaults ?? [],
          writeCapable: options.defaultsWriteCapable ?? [],
        },
      });
    }
    if (path === '/api/v1/agent-runs/agents') {
      return json({ data: AGENTS });
    }
    if (method === 'POST' && path === '/api/v1/orchestrations') {
      if (options.launchStatus && options.launchStatus >= 400) {
        return json({ error: { code: 'CHILD_NOT_ALLOWED', message: 'raw' } }, options.launchStatus);
      }
      return json({ data: { orchestrationId: 'o9', status: 'ACTIVE', workflowId: 'orch-o9' } });
    }
    throw new Error(`No fetch mock for ${method} ${path}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  auth.role = 'ENGINEER';
  cleanup();
  vi.unstubAllGlobals();
  push.mockClear();
});

async function fill(task: string) {
  fireEvent.change(await screen.findByLabelText(/^Task/), { target: { value: task } });
}

describe('OrchestrateForm validation', () => {
  it('needs a task and at least one agent before it reviews', async () => {
    gateway();
    render(withQuery(<OrchestrateForm />));
    await screen.findByLabelText(/Researcher/);
    fireEvent.click(screen.getByRole('button', { name: /Review orchestration/ }));
    expect(screen.getByText('Tell the orchestrator what to do')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/at least one agent/);
    expect(screen.queryByText('Review and launch')).toBeNull();
  });

  it('needs a team when there is no repository and several teams to choose from', async () => {
    gateway({
      teams: [
        { id: 't1', name: 'Payments' },
        { id: 't2', name: 'Platform' },
      ],
    });
    render(withQuery(<OrchestrateForm />));
    await fill('Investigate');
    fireEvent.click(await screen.findByLabelText(/Researcher/));
    fireEvent.click(screen.getByRole('button', { name: /Review orchestration/ }));
    expect(await screen.findByText(/Choose a team, or a repository/)).toBeTruthy();
    expect(screen.queryByText('Review and launch')).toBeNull();
  });
});

describe('OrchestrateForm launch', () => {
  it('reviews, then launches repo-less under the only team with an Idempotency-Key', async () => {
    const spy = gateway();
    render(withQuery(<OrchestrateForm />));
    await fill('Investigate the flake');
    fireEvent.click(await screen.findByLabelText(/Researcher/));
    fireEvent.click(screen.getByRole('button', { name: /Review orchestration/ }));
    expect(await screen.findByText('Review and launch')).toBeTruthy();
    expect(screen.getByText('Investigate the flake')).toBeTruthy();
    expect(screen.getByText(/None. Agents can read and report/)).toBeTruthy();
    // No connections were chosen, so no approval warning.
    expect(screen.queryByText('Every write asks first')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Launch orchestration' }));
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/orchestrations/o9'));
    expect(bodyOf(spy, '/api/v1/orchestrations')).toEqual({
      allowlist: ['researcher'],
      budgetTier: 'STANDARD',
      deliveryDefault: 'none',
      task: 'Investigate the flake',
      teamId: 't1',
    });
    const post = spy.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
    );
    const init = (post?.[1] ?? {}) as RequestInit;
    expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy();
  });

  it('shows our wording for a refusal from the gateway', async () => {
    gateway({ launchStatus: 409 });
    render(withQuery(<OrchestrateForm />));
    await fill('Do it');
    fireEvent.click(await screen.findByLabelText(/Researcher/));
    fireEvent.click(screen.getByRole('button', { name: /Review orchestration/ }));
    await screen.findByText('Review and launch');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Launch orchestration' }));
    });
    expect(
      await screen.findByText('That agent is not on this orchestration’s allowlist.')
    ).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('renders a task with markup as plain text on the review step', async () => {
    gateway();
    render(withQuery(<OrchestrateForm />));
    await fill('<img src=x onerror=alert(1)>');
    fireEvent.click(await screen.findByLabelText(/Writer/));
    fireEvent.click(screen.getByRole('button', { name: /Review orchestration/ }));
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('OrchestrateForm default allowlist', () => {
  it('pre-selects the platform default and launches with it, unchanged', async () => {
    const spy = gateway({ defaults: ['researcher', 'gone'] });
    render(withQuery(<OrchestrateForm />));
    await fill('Investigate the flake');
    const researcher = (await screen.findByLabelText(/Researcher/)) as HTMLInputElement;
    await waitFor(() => expect(researcher.checked).toBe(true));
    expect((screen.getByLabelText(/Writer/) as HTMLInputElement).checked).toBe(false);
    expect(
      spy.mock.calls.some(([u]) => String(u).includes('/orchestrations/defaults?teamId=t1'))
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Review orchestration/ }));
    expect(await screen.findByText('Agents it may start (platform default)')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Launch orchestration' }));
    });
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(bodyOf(spy, '/api/v1/orchestrations')).toMatchObject({ allowlist: ['researcher'] });
  });

  it('marks a default agent that can change files, in the list and on the review step', async () => {
    gateway({ defaults: ['researcher', 'writer'], defaultsWriteCapable: ['writer'] });
    render(withQuery(<OrchestrateForm />));
    await fill('Investigate the flake');
    expect(await screen.findByLabelText(/Writer \(can change files\)/)).toBeTruthy();
    expect(screen.queryByLabelText(/Researcher \(can change files\)/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Review orchestration/ }));
    expect(await screen.findByText(/Researcher, Writer \(can change files\)/)).toBeTruthy();
  });

  it('lets the person change the selection, and sends what they chose', async () => {
    const spy = gateway({ defaults: ['researcher'] });
    render(withQuery(<OrchestrateForm />));
    await fill('Investigate the flake');
    const researcher = (await screen.findByLabelText(/Researcher/)) as HTMLInputElement;
    await waitFor(() => expect(researcher.checked).toBe(true));
    fireEvent.click(screen.getByLabelText(/Writer/));
    fireEvent.click(researcher);
    expect(researcher.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Review orchestration/ }));
    expect(await screen.findByText('Agents it may start')).toBeTruthy();
    expect(screen.queryByText(/platform default\)/)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Launch orchestration' }));
    });
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(bodyOf(spy, '/api/v1/orchestrations')).toMatchObject({ allowlist: ['writer'] });
  });
});

describe('OrchestrateForm connections', () => {
  const go = async (agent: RegExp) => {
    await fill('Triage the queue');
    fireEvent.click(await screen.findByLabelText(agent));
  };

  it('lists the team’s connections for a non-admin from the orchestration route', async () => {
    auth.role = 'ENGINEER';
    const spy = gateway({ connections: [{ id: 'c1', name: 'Linear' }] });
    render(withQuery(<OrchestrateForm />));
    await go(/Researcher/);
    fireEvent.click(await screen.findByLabelText('Linear'));
    expect(
      spy.mock.calls.some(([u]) => String(u).includes('/orchestrations/connections?teamId=t1'))
    ).toBe(true);
    // A non-admin never asks for the ADMIN-only platform list.
    expect(spy.mock.calls.some(([u]) => String(u).includes('/platform/mcp-connections'))).toBe(
      false
    );
    fireEvent.click(screen.getByRole('button', { name: /Review orchestration/ }));
    expect(await screen.findByText('Review and launch')).toBeTruthy();
    expect(screen.getByText('Linear')).toBeTruthy();
    expect(screen.getByText('Every write asks first')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Launch orchestration' }));
    });
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(bodyOf(spy, '/api/v1/orchestrations')).toMatchObject({ connectionIds: ['c1'] });
  });

  it('says so when the team’s connections cannot be loaded', async () => {
    auth.role = 'ENGINEER';
    const spy = gateway();
    const real = spy.getMockImplementation();
    spy.mockImplementation(async (input, init) => {
      if (String(input).includes('/orchestrations/connections')) {
        return new Response('{}', { status: 500 });
      }
      return (real as NonNullable<typeof real>)(input, init);
    });
    render(withQuery(<OrchestrateForm />));
    expect(await screen.findByText('Could not load this team’s MCP connections.')).toBeTruthy();
  });

  it('always lists the connections on the review step, and warns when none was chosen but an agent uses MCP', async () => {
    auth.role = 'ADMIN';
    gateway({
      platformConnections: [
        {
          id: 'c1',
          name: 'Linear',
          teamId: 't1',
          usedBy: [{ key: 'researcher', name: 'Researcher', scope: 'GLOBAL' }],
        },
      ],
    });
    render(withQuery(<OrchestrateForm />));
    await go(/Researcher/);
    await screen.findByLabelText('Linear');
    fireEvent.click(screen.getByRole('button', { name: /Review orchestration/ }));
    expect(await screen.findByText('Review and launch')).toBeTruthy();
    expect(screen.getByText('MCP connections')).toBeTruthy();
    expect(screen.getByText(/None chosen/)).toBeTruthy();
    expect(screen.getByText('Every write asks first')).toBeTruthy();
  });

  it('shows who reaches a chosen connection, for an admin', async () => {
    auth.role = 'ADMIN';
    gateway({
      platformConnections: [
        {
          id: 'c1',
          name: 'Linear',
          teamId: 't1',
          usedBy: [{ key: 'researcher', name: 'Researcher', scope: 'GLOBAL' }],
        },
      ],
    });
    render(withQuery(<OrchestrateForm />));
    await go(/Researcher/);
    fireEvent.click(await screen.findByLabelText('Linear'));
    fireEvent.click(screen.getByRole('button', { name: /Review orchestration/ }));
    expect(await screen.findByText(/Linear \(reachable by Researcher\)/)).toBeTruthy();
  });

  it('shows no write warning when there are no connections at all', async () => {
    auth.role = 'ENGINEER';
    gateway();
    render(withQuery(<OrchestrateForm />));
    await go(/Researcher/);
    fireEvent.click(screen.getByRole('button', { name: /Review orchestration/ }));
    await screen.findByText('Review and launch');
    expect(screen.getByText(/None chosen/)).toBeTruthy();
    expect(screen.queryByText('Every write asks first')).toBeNull();
  });
});
