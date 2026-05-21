// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import EpicsPage from './page';

// next/navigation router is replaced for the redirect assertion
const pushSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushSpy }),
}));

// authStore drives the role gate on the "+ New epic" button — admin/lead only.
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: { role: string } | null }) => unknown) =>
    selector({ user: { role: 'LEAD' } }),
}));

beforeEach(stubDialogPrototype);
afterEach(() => {
  pushSpy.mockReset();
  vi.unstubAllGlobals();
});

const REPOS = [
  {
    _count: { activeWorkflows: 0 },
    defaultBranch: 'main',
    description: null,
    executorImage: null,
    id: 'r1',
    isActive: true,
    language: null,
    organizationName: 'acme',
    repoName: 'payments-api',
    team: { id: 't1', name: 'platform', slug: 'platform' },
  },
  {
    _count: { activeWorkflows: 0 },
    defaultBranch: 'main',
    description: null,
    executorImage: null,
    id: 'r2',
    isActive: true,
    language: null,
    organizationName: 'acme',
    repoName: 'gateway',
    team: { id: 't1', name: 'platform', slug: 'platform' },
  },
];

describe('EpicsPage — new epic', () => {
  it('rejects single-repo selection (use Work Requests instead)', async () => {
    setupFetchMock({
      'GET /api/v1/repositories': () => ({ data: REPOS }),
      'POST /api/v1/epics': () => ({
        data: { epicWorkflowId: 'epic-1', workRequestId: 'wr-1' },
      }),
    });

    render(withQuery(<EpicsPage />));
    // Button is disabled={repos.length < 2}; wait for the repos fetch to
    // resolve (button becomes enabled) before clicking, otherwise the click
    // hits a disabled button and the modal never opens.
    const newEpic = await waitFor(() => {
      const btn = screen.getByRole('button', { name: /new epic/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    fireEvent.click(newEpic);

    fireEvent.change(screen.getByLabelText(/external ticket id/i), {
      target: { value: 'EPIC-100' },
    });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: 'Migrate the legacy auth path everywhere.' },
    });

    // Pick only ONE repo (RTL can't reliably match the checkbox by accessible
    // name because the label includes branch-suffix text — use the checkbox
    // index instead, which is stable: the test fixtures define exactly 2)
    const checkboxes = await screen.findAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole('button', { name: /launch epic/i }));

    await waitFor(() => {
      expect(screen.getByText(/at least two repositories/i)).toBeTruthy();
    });
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('submits with ≥2 repos and routes to the epic workflow', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/repositories': () => ({ data: REPOS }),
      'POST /api/v1/epics': () => ({
        data: { epicWorkflowId: 'epic-xyz', workRequestId: 'wr-xyz' },
      }),
    });

    render(withQuery(<EpicsPage />));
    // Button is disabled={repos.length < 2}; wait for the repos fetch to
    // resolve (button becomes enabled) before clicking, otherwise the click
    // hits a disabled button and the modal never opens.
    const newEpic = await waitFor(() => {
      const btn = screen.getByRole('button', { name: /new epic/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    fireEvent.click(newEpic);

    fireEvent.change(screen.getByLabelText(/external ticket id/i), {
      target: { value: 'EPIC-100' },
    });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: 'Migrate the legacy auth path everywhere.' },
    });

    // Pick BOTH repos by index — see name-match note above
    const checkboxes = await screen.findAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole('button', { name: /launch epic/i }));

    await waitFor(() => expect(pushSpy).toHaveBeenCalledWith('/workflows/epic-xyz'));

    expect(bodyOf(spy, '/api/v1/epics', 'POST')).toEqual({
      description: 'Migrate the legacy auth path everywhere.',
      externalTicketId: 'EPIC-100',
      repoIds: ['r1', 'r2'],
    });
  });
});
