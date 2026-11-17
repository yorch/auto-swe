// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQuery } from '@/test/rtl-helpers';
import { TeamAttentionSection } from './TeamAttentionSection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TEAM = { id: 't-1', slug: 'payments' };

interface Reply {
  body: unknown;
  status?: number;
}

/** A fetch stub whose handlers may answer with an error status, which `setupFetchMock` cannot. */
function gateway(handlers: Record<string, () => Reply>) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${path}`;
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`No fetch mock for ${key}`);
    }
    const { body, status = 200 } = handler();
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      status,
    });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const failure = (over: Record<string, unknown> = {}) => ({
  failedAt: '2026-11-15T10:00:00.000Z',
  formerLauncherName: 'Dana',
  repoName: 'acme/api',
  requestId: 'q1',
  runId: 'run-1',
  title: 'Fix the flaky login test',
  ...over,
});

const step = (over: Record<string, unknown> = {}) => ({
  hasSlackThread: true,
  id: 'step-1',
  kind: 'APPROVAL',
  nodeId: 'n',
  requestedAt: '2026-11-10T10:00:00.000Z',
  run: { id: 'run-1', status: 'RUNNING', workflowId: 'w' },
  runId: 'run-1',
  status: 'PENDING',
  timeoutAt: '2026-11-14T10:00:00.000Z',
  title: 'Approve the deploy',
  ...over,
});

const OVERVIEW = {
  data: { lead: { openPullRequests: 4, staleApprovals: 1, unownedFailures: 1 } },
};

function baseHandlers(over: Record<string, () => Reply> = {}) {
  return {
    'GET /api/v1/human-steps': () => ({ body: { data: [step()] } }),
    'GET /api/v1/teams/t-1': () => ({
      body: {
        data: {
          id: 't-1',
          memberships: [
            { id: 'm1', role: 'LEAD', user: { email: 'ana@acme.test', id: 'u1', role: 'LEAD' } },
            {
              id: 'm2',
              role: 'ENGINEER',
              user: { email: 'bo@acme.test', id: 'u2', role: 'ENGINEER' },
            },
          ],
        },
      },
    }),
    'GET /api/v1/teams/t-1/attention/failures': () => ({ body: { data: [failure()] } }),
    'GET /api/v1/teams/t-1/overview': () => ({ body: OVERVIEW }),
    ...over,
  };
}

function renderSection() {
  render(withQuery(<TeamAttentionSection team={TEAM} />));
}

async function openAssign(email = 'ana@acme.test') {
  fireEvent.click(await screen.findByRole('button', { name: 'Assign' }));
  const select = screen.getByLabelText('Assign to') as HTMLSelectElement;
  const option = within(select).getByRole('option', { name: email }) as HTMLOptionElement;
  fireEvent.change(select, { target: { value: option.value } });
  return select;
}

describe('TeamAttentionSection', () => {
  it('is titled Attention and lists each unowned failure with its repository and former launcher', async () => {
    gateway(baseHandlers());
    renderSection();
    expect(await screen.findByRole('heading', { name: 'Attention' })).toBeTruthy();
    expect(await screen.findByText('Fix the flaky login test')).toBeTruthy();
    expect(screen.getByText('acme/api')).toBeTruthy();
    expect(screen.getByText(/Dana/)).toBeTruthy();
  });

  it('says so when no failure lacks an owner', async () => {
    gateway(
      baseHandlers({ 'GET /api/v1/teams/t-1/attention/failures': () => ({ body: { data: [] } }) })
    );
    renderSection();
    expect(await screen.findByText('No failures without an owner.')).toBeTruthy();
  });

  it('offers Assign only once the members have loaded', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = gateway(baseHandlers());
    const real = spy.getMockImplementation();
    spy.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/api/v1/teams/t-1')) {
        await gate;
      }
      return (real as NonNullable<typeof real>)(input, init);
    });
    renderSection();
    expect(await screen.findByText('Fix the flaky login test')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull();
    release();
    expect(await screen.findByRole('button', { name: 'Assign' })).toBeTruthy();
  });

  it('assigns a failure to the chosen member and refreshes the list', async () => {
    let assigned = false;
    const spy = gateway(
      baseHandlers({
        'GET /api/v1/teams/t-1/attention/failures': () => ({
          body: { data: assigned ? [] : [failure()] },
        }),
        'POST /api/v1/teams/t-1/failure-assignments': () => {
          assigned = true;
          return {
            body: { data: { assignedAt: 'x', assigneeId: 'u1', runId: 'run-1' } },
            status: 201,
          };
        },
      })
    );
    renderSection();
    await openAssign();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('No failures without an owner.')).toBeTruthy();
    const post = spy.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ assigneeId: 'u1', runId: 'run-1' });
    expect(spy.mock.calls.some(([u]) => String(u).endsWith('/teams/t-1/overview'))).toBe(true);
  });

  it.each([
    [409, 'NOT_UNOWNED_FAILURE', 'Someone else already took this failure.'],
    [422, 'ASSIGNEE_NOT_MEMBER', 'That person is not a member of this team.'],
  ])('shows the %i error and keeps the row', async (status, code, message) => {
    gateway(
      baseHandlers({
        'POST /api/v1/teams/t-1/failure-assignments': () => ({
          body: { error: { code, message } },
          status,
        }),
      })
    );
    renderSection();
    await openAssign();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByText('Fix the flaky login test')).toBeTruthy();
  });

  it('lists stale approvals with a Nudge only where there is a Slack thread, and the hint', async () => {
    gateway(
      baseHandlers({
        'GET /api/v1/human-steps': () => ({
          body: {
            data: [
              step(),
              step({ hasSlackThread: false, id: 'step-2', title: 'Approve the migration' }),
            ],
          },
        }),
      })
    );
    renderSection();
    const withThread = (await screen.findByText('Approve the deploy')).closest('li') as HTMLElement;
    const without = screen.getByText('Approve the migration').closest('li') as HTMLElement;
    expect(within(withThread).getByRole('button', { name: 'Nudge' })).toBeTruthy();
    expect(within(without).queryByRole('button', { name: 'Nudge' })).toBeNull();
    expect(screen.getByText("Replies in the step's Slack thread.")).toBeTruthy();
  });

  it('requests overdue pending steps of the team', async () => {
    const spy = gateway(baseHandlers());
    renderSection();
    await screen.findByText('Approve the deploy');
    const call = spy.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/human-steps'));
    expect(call).toContain('overdue=true');
    expect(call).toContain('teamId=t-1');
  });

  it('shows Nudged and disables the button after a nudge', async () => {
    gateway(
      baseHandlers({
        'POST /api/v1/human-steps/step-1/nudge': () => ({
          body: { data: { nudgedAt: new Date().toISOString() } },
        }),
      })
    );
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Nudge' }));
    const done = (await screen.findByRole('button', { name: 'Nudged' })) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
  });

  it('explains a 429 on a nudge', async () => {
    gateway(
      baseHandlers({
        'POST /api/v1/human-steps/step-1/nudge': () => ({
          body: { error: { code: 'NUDGE_RATE_LIMITED', message: 'raw' } },
          status: 429,
        }),
      })
    );
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Nudge' }));
    expect(await screen.findByText('Already nudged in the last 4 hours.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Nudged' })).toBeNull());
  });

  it('links the open pull request count to the team’s open pull requests', async () => {
    gateway(baseHandlers());
    renderSection();
    const link = await screen.findByRole('link', { name: /4 open pull requests/ });
    expect(link.getAttribute('href')).toBe('/pull-requests?scope=TEAM&state=OPEN&team=payments');
  });

  it('shows no pull request count before the overview arrives', async () => {
    const spy = gateway(baseHandlers());
    const real = spy.getMockImplementation();
    spy.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/overview')) {
        return new Promise<Response>(() => undefined);
      }
      return (real as NonNullable<typeof real>)(input, init);
    });
    renderSection();
    await screen.findByText('Fix the flaky login test');
    expect(screen.queryByRole('link', { name: /pull request/ })).toBeNull();
  });
});
