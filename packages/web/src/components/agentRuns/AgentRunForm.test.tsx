// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQuery } from '@/test/rtl-helpers';
import { AgentRunForm } from './AgentRunForm';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const REPO = {
  _count: { activeWorkflows: 0 },
  id: 'repo-1',
  organizationName: 'acme',
  repoName: 'api',
  team: { id: 't1', name: 'platform', slug: 'platform' },
  type: 'git_repo',
};
const NOT_GIT = { ...REPO, id: 'mcp-1', name: 'My MCP', type: 'mcp' };

const AGENTS = [
  {
    description: 'Writes content',
    key: 'contentWriter',
    name: 'Content writer',
    pinnableVersions: [3, 2],
    scope: 'GLOBAL',
    version: 3,
  },
];

const LIMITS = {
  concurrency: { global: 4, perTeam: 2 },
  enabled: true,
  maxSteps: { ceiling: 50, max: 500, min: 1 },
  maxWallClockSeconds: { ceiling: 1800, max: 14400, min: 60 },
};

interface Stub {
  limits?: unknown;
  launch?: () => Response;
}

function stubGateway(stub: Stub = {}) {
  const launches: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      status,
    });
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && path === '/api/v1/repositories') {
      return json({ data: [REPO, NOT_GIT], meta: { limit: 500, offset: 0, total: 2 } });
    }
    if (method === 'GET' && path === '/api/v1/agent-runs/agents') {
      return json({ data: AGENTS });
    }
    if (method === 'GET' && path === '/api/v1/agent-runs/limits') {
      return json({ data: stub.limits ?? LIMITS });
    }
    if (method === 'GET' && path === '/api/v1/workflow-runs') {
      return json({ data: [] });
    }
    if (method === 'POST' && path === '/api/v1/agent-runs') {
      launches.push({
        body: JSON.parse(init?.body as string),
        headers: init?.headers as Record<string, string>,
      });
      return (
        stub.launch?.() ??
        json(
          {
            data: {
              effective: { deliver: 'none', maxSteps: 50, maxWallClockSeconds: 1800 },
              temporalWorkflowId: 'agent-1',
              workflowId: 'aw-1',
              workRequestId: 'wr-1',
            },
          },
          201
        )
      );
    }
    throw new Error(`unmocked ${method} ${path}`);
  });
  vi.stubGlobal('fetch', spy);
  return { launches, spy };
}

/** Focus a combobox, type, and pick the option, as the Combobox tests do. */
function pick(name: RegExp, text: string, option: RegExp) {
  const input = screen.getByRole('combobox', { name });
  act(() => input.focus());
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole('option', { name: option }));
}

async function fill(prompt = 'fix the typo') {
  await waitFor(() => expect(screen.getByRole('combobox', { name: /repository/i })).toBeTruthy());
  await waitFor(() =>
    expect(
      (screen.getByRole('combobox', { name: /repository/i }) as HTMLInputElement).placeholder
    ).not.toMatch(/loading/i)
  );
  pick(/repository/i, 'acme', /acme\/api/);
  await waitFor(() =>
    expect((screen.getByRole('combobox', { name: /agent/i }) as HTMLInputElement).disabled).toBe(
      false
    )
  );
  await waitFor(() => expect(screen.getByText(/Platform ceiling: 50/)).toBeTruthy());
  pick(/^agent/i, 'content', /Content writer/);
  fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: prompt } });
}

describe('AgentRunForm', () => {
  it('offers git repositories only, and shows the platform ceilings once a repository is chosen', async () => {
    stubGateway();
    render(withQuery(<AgentRunForm />));
    await fill();
    expect(screen.getByText(/Platform ceiling: 50\./)).toBeTruthy();
    expect(screen.getByText(/Platform ceiling: 1800\./)).toBeTruthy();
    expect(screen.queryByRole('option', { name: /My MCP/ })).toBeNull();
  });

  it('refuses a cap above the ceiling client-side and sends nothing', async () => {
    const { launches } = stubGateway();
    render(withQuery(<AgentRunForm />));
    await fill();
    fireEvent.change(screen.getByLabelText(/max steps/i), { target: { value: '51' } });
    fireEvent.click(screen.getByRole('button', { name: /run agent/i }));
    expect(await screen.findByText(/can only lower the platform ceiling of 50/)).toBeTruthy();
    expect(launches).toEqual([]);
  });

  it('launches with the chosen values and an Idempotency-Key', async () => {
    const { launches } = stubGateway();
    render(withQuery(<AgentRunForm />));
    await fill();
    fireEvent.change(screen.getByLabelText(/max steps/i), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('radio', { name: /draft pull request/i }));
    fireEvent.click(screen.getByRole('button', { name: /run agent/i }));
    expect(await screen.findByText(/Agent run started/)).toBeTruthy();
    expect(launches).toHaveLength(1);
    expect(launches[0]?.body).toEqual({
      agent: 'contentWriter',
      deliver: 'draft_pr',
      maxSteps: 10,
      prompt: 'fix the typo',
      repoId: 'repo-1',
    });
    expect(launches[0]?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('renders the 429 concurrency error clearly and reuses the key on an identical retry', async () => {
    const reject = () =>
      new Response(
        JSON.stringify({
          error: { code: 'AGENT_RUN_CONCURRENCY_EXCEEDED', message: 'at the team limit' },
        }),
        { headers: { 'content-type': 'application/json' }, status: 429 }
      );
    const { launches } = stubGateway({ launch: reject });
    render(withQuery(<AgentRunForm />));
    await fill();
    const button = () => screen.getByRole('button', { name: /run agent/i });
    fireEvent.click(button());
    expect(await screen.findByText(/Too many agent runs in flight/)).toBeTruthy();
    expect(screen.getByText('at the team limit')).toBeTruthy();
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(launches).toHaveLength(2));
    expect(launches[1]?.headers['Idempotency-Key']).toBe(launches[0]?.headers['Idempotency-Key']);
  });

  it('shows 403 AGENT_RUNS_DISABLED and 400 CAP_EXCEEDS_CEILING by their codes', async () => {
    let n = 0;
    const codes = [
      [403, 'AGENT_RUNS_DISABLED', 'Agent runs are turned off'],
      [400, 'CAP_EXCEEDS_CEILING', 'Limit above the platform ceiling'],
    ] as const;
    const { launches } = stubGateway({
      launch: () => {
        const [status, code] = codes[n++] ?? codes[1];
        return new Response(JSON.stringify({ error: { code, message: code } }), {
          headers: { 'content-type': 'application/json' },
          status,
        });
      },
    });
    render(withQuery(<AgentRunForm />));
    await fill();
    fireEvent.click(screen.getByRole('button', { name: /run agent/i }));
    expect(await screen.findByText(new RegExp(codes[0][2]))).toBeTruthy();
    // Editing the prompt clears the stale error, then the next launch fails differently.
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: 'again' } });
    fireEvent.click(screen.getByRole('button', { name: /run agent/i }));
    expect(await screen.findByText(new RegExp(codes[1][2]))).toBeTruthy();
    expect(launches).toHaveLength(2);
    // A changed prompt is a different submission and gets a different key.
    expect(launches[1]?.headers['Idempotency-Key']).not.toBe(
      launches[0]?.headers['Idempotency-Key']
    );
  });

  it('reviews before launch, preserves values on Back, and opens the request after launch', async () => {
    const { launches } = stubGateway();
    const launched = vi.fn();
    render(withQuery(<AgentRunForm onLaunched={launched} reviewBeforeLaunch />));
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Review agent run' }));
    expect(screen.getByText('Review and launch')).toBeTruthy();
    expect(launches).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Back to details' }));
    expect((screen.getByLabelText(/prompt/i) as HTMLTextAreaElement).value).toBe('fix the typo');
    fireEvent.click(screen.getByRole('button', { name: 'Review agent run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Launch agent' }));
    await waitFor(() => expect(launched).toHaveBeenCalledTimes(1));
    expect(launches).toHaveLength(1);
  });

  it('blocks launching when the platform has agent runs turned off', async () => {
    stubGateway({ limits: { ...LIMITS, enabled: false } });
    render(withQuery(<AgentRunForm />));
    await fill();
    expect(await screen.findByText(/Agent runs are turned off/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /run agent/i }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('offers version pins for the chosen agent', async () => {
    stubGateway();
    render(withQuery(<AgentRunForm />));
    await fill();
    expect(await screen.findByText(/Latest is v3/)).toBeTruthy();
  });
});
