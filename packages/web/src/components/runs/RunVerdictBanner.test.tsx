// @vitest-environment jsdom

import type { WorkflowRunDetail, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deriveRunVerdict } from '@/lib/runVerdict';
import { RunVerdictBanner } from './RunVerdictBanner';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const setupStep = {
  attempt: 1,
  error: 'WORKSPACE_SETUP_FAILED: missing setup secret',
  id: 'step',
  nodeId: 'implement',
  status: 'FAILED',
} as WorkflowStepRecord;
const setupRun = {
  contextSnapshot: { request: { repoId: 'repo' } },
  costUsdAccrued: 0,
  isAgentRun: true,
  status: 'FAILED',
  steps: [setupStep],
  workflowId: 'workflow',
} as unknown as WorkflowRunDetail;
const setupBlocker = {
  kind: 'missing_secret',
  lastWorkflowId: setupRun.workflowId,
  remedy: "Add secret TOKEN under the repository's setup secrets.",
  resolvedAt: '2026-11-01T00:00:00Z',
};

function setupBanner(blockers: unknown[], status = 200) {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify(status === 200 ? { blockers } : { error: { message: 'Forbidden' } }),
        { status }
      )
  );
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const jump = vi.fn();
  const verdict = deriveRunVerdict(setupRun);
  render(
    <QueryClientProvider client={client}>
      <RunVerdictBanner onJumpToFailure={jump} run={setupRun} verdict={verdict} />
    </QueryClientProvider>
  );
  return { client, fetch, jump, verdict };
}

it('uses the matching setup blocker in the verdict and phone outcome details', async () => {
  const { fetch, jump } = setupBanner([
    { ...setupBlocker, lastWorkflowId: 'other', remedy: 'Wrong remedy' },
    setupBlocker,
  ]);
  expect(await screen.findByText('Missing secret')).toBeTruthy();
  expect(screen.getByText(setupBlocker.remedy)).toBeTruthy();
  expect(screen.queryByText(/does not recognise|Wrong remedy/)).toBeNull();
  expect(String(fetch.mock.calls[0]?.[0])).toContain(
    '/repositories/repo/setup-blockers?includeResolved=true'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Jump to the failed step' }));
  expect(jump).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Outcome details' }));
  expect(screen.getByRole('region', { name: 'Outcome explanation' }).textContent).toBe(
    setupBlocker.remedy
  );
});

it.each([200, 403])(
  'keeps the original verdict with no matching setup blocker (HTTP %s)',
  async (status) => {
    const { client, fetch, verdict } = setupBanner(
      [{ ...setupBlocker, lastWorkflowId: 'other' }],
      status
    );
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(fetch).toHaveBeenCalledOnce();
    expect(screen.getByText(verdict.headline)).toBeTruthy();
    expect(screen.getByText(verdict.detail)).toBeTruthy();
    expect(screen.queryByText('Missing secret')).toBeNull();
    expect(screen.queryByText('Forbidden')).toBeNull();
  }
);

it('keeps long phone explanations outside the verdict layout and restores focus on dismiss', () => {
  const jump = vi.fn();
  const detail = 'A long failure explanation. '.repeat(40);
  render(
    <RunVerdictBanner
      onJumpToFailure={jump}
      verdict={{
        detail,
        headline: 'Stopped at implementation',
        nextAction: { kind: 'jump-to-failure', label: 'Jump to failure' },
        tone: 'error',
      }}
    />
  );
  const trigger = screen.getByRole('button', { name: 'Outcome details' });
  expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
  expect(screen.queryByRole('dialog')).toBeNull();
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Outcome details' });
  expect(within(dialog).getByRole('region', { name: 'Outcome explanation' }).textContent).toBe(
    detail
  );
  expect(document.activeElement).toBe(
    within(dialog).getByRole('region', { name: 'Outcome explanation' })
  );
  expect(trigger.closest('[data-tour="run:verdict"]')?.contains(dialog)).toBe(false);
  expect(within(dialog).getByText('Stopped at implementation')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  const reopened = screen.getByRole('dialog', { name: 'Outcome details' });
  fireEvent.mouseDown(reopened);
  fireEvent.click(reopened);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(screen.getAllByRole('button', { name: 'Jump to failure' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Jump to failure' }));
  expect(jump).toHaveBeenCalledOnce();
});
