// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { PrdRunLaunchForm } from './PrdRunLaunchForm';

// The platform role is ENGINEER throughout: the form follows whether the caller leads a team.
const auth = vi.hoisted(() => ({ leads: true, role: 'ENGINEER' }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: { role: string } | null }) => unknown) =>
    selector({ user: { role: auth.role } }),
}));
vi.mock('@/hooks/useTeams', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useTeams')>()),
  useLeadsATeam: () => auth.leads,
}));

afterEach(() => {
  cleanup();
  auth.role = 'ENGINEER';
  auth.leads = true;
  vi.unstubAllGlobals();
});

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const repo = (id: string, repoName: string) => ({
  _count: { activeWorkflows: 0 },
  defaultBranch: 'main',
  description: null,
  executorImage: null,
  id,
  isActive: true,
  language: null,
  organizationName: 'acme',
  repoName,
  team: { id: 't1', name: 'platform', slug: 'platform' },
});
const REPOS = [repo(R1, 'payments-api'), repo(R2, 'gateway')];
const STARTED = { data: { prdWorkflowId: 'prd-x-1a2b3c4d', workRequestId: 'wr-1' } };

function fill() {
  fireEvent.change(screen.getByLabelText(/prd title/i), { target: { value: 'Invitations' } });
  fireEvent.change(screen.getByLabelText(/prd text/i), { target: { value: 'Invite people.' } });
}

describe('PrdRunLaunchForm', () => {
  it('tells someone who leads no team the run needs a lead and offers no form', () => {
    auth.leads = false;
    setupFetchMock({ 'GET /api/v1/repositories': () => ({ data: REPOS }) });
    render(withQuery(<PrdRunLaunchForm />));
    expect(screen.getByText(/needs a team lead or administrator/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /prd run/i })).toBeNull();
  });

  it('requires a repository before it calls the gateway', async () => {
    const spy = setupFetchMock({ 'GET /api/v1/repositories': () => ({ data: REPOS }) });
    render(withQuery(<PrdRunLaunchForm />));
    await screen.findAllByRole('checkbox');
    fill();
    fireEvent.click(screen.getByRole('button', { name: /start prd run/i }));
    expect(await screen.findByText(/pick at least one repository/i)).toBeTruthy();
    expect(spy.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'POST')).toBe(false);
  });

  it('posts the schema body, omits a blank tracker project and links to the run', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/repositories': () => ({ data: REPOS }),
      'GET /api/v1/workflow-runs': () => ({ data: [{ id: 'run-9' }] }),
      'POST /api/v1/prd-runs': () => STARTED,
    });
    render(withQuery(<PrdRunLaunchForm />));
    const boxes = await screen.findAllByRole('checkbox');
    fill();
    fireEvent.click(boxes[1] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /start prd run/i }));
    const link = await screen.findByRole('link', { name: /open the run/i });
    expect(link.getAttribute('href')).toBe('/runs/run-9');
    expect(bodyOf(spy, '/api/v1/prd-runs')).toEqual({
      prdContent: 'Invite people.',
      prdTitle: 'Invitations',
      repoIds: [R2],
    });
    const post = spy.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    expect(
      (((post as unknown[])[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key']
    ).toBeTruthy();
  });

  it('sends the tracker project when given', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/repositories': () => ({ data: REPOS }),
      'GET /api/v1/workflow-runs': () => ({ data: [] }),
      'POST /api/v1/prd-runs': () => STARTED,
    });
    render(withQuery(<PrdRunLaunchForm />));
    const boxes = await screen.findAllByRole('checkbox');
    fill();
    fireEvent.change(screen.getByLabelText(/tracker project/i), { target: { value: ' PAY ' } });
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /start prd run/i }));
    expect(await screen.findByRole('link', { name: /open the request/i })).toBeTruthy();
    expect(bodyOf(spy, '/api/v1/prd-runs')).toMatchObject({ projectKey: 'PAY', repoIds: [R1] });
  });

  it('names each repository the gateway refuses for team-lead-required', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const post = (init?.method ?? 'GET') === 'POST';
        return new Response(
          JSON.stringify(
            post
              ? {
                  error: {
                    code: 'FORBIDDEN',
                    message:
                      'This launch requires team LEAD or ADMIN on the team that owns each repository: acme/gateway',
                    reasons: [{ reason: 'team-lead-required', repo: 'acme/gateway' }],
                  },
                }
              : { data: REPOS }
          ),
          {
            headers: { 'content-type': 'application/json' },
            status: post ? 403 : 200,
          }
        );
      })
    );
    render(withQuery(<PrdRunLaunchForm />));
    const boxes = await screen.findAllByRole('checkbox');
    fill();
    fireEvent.click(boxes[1] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /start prd run/i }));
    await waitFor(() => expect(screen.getByTestId('prd-refused-repos')).toBeTruthy());
    expect(screen.getByTestId('prd-refused-repos').textContent).toMatch(/acme\/gateway/);
  });
});
