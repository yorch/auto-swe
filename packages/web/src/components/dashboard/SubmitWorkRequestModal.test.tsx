// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubmitWorkRequestModal } from './SubmitWorkRequestModal';

// next/navigation's useRouter is a hook with internals tied to the App Router;
// for an isolated component test we replace it with a spy. The same router push
// shape is used throughout the modal so this captures the only side-effect we
// care about ("on success, navigate to the new run").
const pushSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushSpy }),
}));

// jsdom doesn't implement HTMLDialogElement.showModal/close at the time of
// writing — the Modal component calls both in a useEffect. Stub them on the
// prototype so the effect doesn't crash. Real browsers run the actual native
// methods; this only matters for the test environment.
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
    };
  }
});

afterEach(() => {
  pushSpy.mockReset();
  vi.unstubAllGlobals();
});

function withQuery(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const REPO_FIXTURE = {
  _count: { activeWorkflows: 0 },
  defaultBranch: 'main',
  description: null,
  executorImage: null,
  id: '11111111-1111-1111-1111-111111111111',
  isActive: true,
  language: null,
  organizationName: 'acme',
  repoName: 'payments-api',
  team: { id: 't1', name: 'platform', slug: 'platform' },
};

function setupFetchMock(handlers: Record<string, (body?: unknown) => unknown>) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const handler = handlers[path];
    if (!handler) {
      throw new Error(`No fetch mock for ${path}`);
    }
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const result = handler(body);
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

describe('SubmitWorkRequestModal', () => {
  it('submits the form and navigates to the new run on success', async () => {
    const NEW_WORKFLOW_ID = '99999999-9999-9999-9999-999999999999';
    const fetchSpy = setupFetchMock({
      '/api/v1/repositories': () => ({ data: [REPO_FIXTURE] }),
      '/api/v1/work-requests': () => ({
        data: { workflowIds: [NEW_WORKFLOW_ID], workRequestId: 'wr-1' },
      }),
    });

    render(withQuery(<SubmitWorkRequestModal onClose={vi.fn()} open={true} />));

    // Wait for useRepositories to resolve and the repo to appear in the dropdown
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /repository/i })).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText(/external ticket id/i), {
      target: { value: 'JIRA-42' },
    });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: 'Add a GET /health endpoint that returns ok' },
    });

    // Default budget tier is STANDARD; switch to LARGE to also exercise the radio group
    fireEvent.click(screen.getByLabelText(/large/i));

    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));

    await waitFor(() => expect(pushSpy).toHaveBeenCalledWith(`/workflows/${NEW_WORKFLOW_ID}`));

    // Inspect the POST body the modal sent — this is what locks in the API contract
    const workReqCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).endsWith('/api/v1/work-requests')
    );
    if (!workReqCall) {
      throw new Error('expected a POST to /api/v1/work-requests');
    }
    const body = JSON.parse((workReqCall[1] as RequestInit).body as string);
    expect(body).toEqual({
      budgetTier: 'LARGE',
      description: 'Add a GET /health endpoint that returns ok',
      externalTicketId: 'JIRA-42',
      repoIds: [REPO_FIXTURE.id],
    });
  });

  it('blocks submission and shows an empty-state when no repositories exist', async () => {
    setupFetchMock({
      '/api/v1/repositories': () => ({ data: [] }),
    });

    render(withQuery(<SubmitWorkRequestModal onClose={vi.fn()} open={true} />));

    await waitFor(() => {
      expect(screen.getByText(/no repositories connected/i)).toBeTruthy();
    });

    // Submit button is disabled until a repo exists — this prevents the
    // POST altogether (the backend would reject it with a 400 anyway).
    const submit = screen.getByRole('button', { name: /^submit$/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});
