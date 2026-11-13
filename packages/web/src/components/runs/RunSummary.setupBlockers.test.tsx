// @vitest-environment jsdom

import type { WorkflowRunDetail, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunSummary } from './RunSummary';

const step = {
  attempt: 1,
  error: 'WORKSPACE_SETUP_FAILED: setup command failed',
  id: 'setup-step',
  nodeId: 'implement',
  status: 'FAILED',
} as WorkflowStepRecord;
const run = {
  contextSnapshot: { request: { repoId: 'repo-setup' } },
  id: 'run-setup',
  result: null,
  status: 'FAILED',
  steps: [step],
  workflowId: 'workflow-setup',
} as unknown as WorkflowRunDetail;
const blocker = {
  detail: 'command not found',
  id: 'blocker',
  kind: 'missing_tool',
  lastWorkflowId: run.workflowId,
  remedy: 'Install `foo` in a setup step or use an image that has it.',
  resolvedAt: '2026-11-01T00:00:00Z',
  step: 'dependencies',
  subject: 'foo',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function respond(blockers: unknown[], status = 200) {
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify(status === 200 ? { blockers } : { error: { message: 'Forbidden' } }),
        { status }
      )
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function show(
  variant: 'full' | 'compact' = 'full',
  over: Partial<WorkflowRunDetail> = {},
  failure = step
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RunSummary
        failedStep={failure}
        pendingSteps={[]}
        run={{ ...run, ...over }}
        variant={variant}
      />
    </QueryClientProvider>
  );
  return client;
}

describe('run setup blockers', () => {
  it.each(['full', 'compact'] as const)(
    'shows the matching resolved blocker and keeps raw diagnostics (%s)',
    async (variant) => {
      const fetch = respond([
        { ...blocker, id: 'other', lastWorkflowId: 'other-workflow', remedy: 'Not this remedy' },
        blocker,
      ]);
      show(variant);
      expect(await screen.findByRole('heading', { name: 'Missing tool' })).toBeTruthy();
      expect(screen.getByText(blocker.remedy)).toBeTruthy();
      expect(screen.getByText('foo')).toBeTruthy();
      expect(screen.getByText('Setup step: dependencies')).toBeTruthy();
      expect(screen.queryByText('Not this remedy')).toBeNull();
      expect(screen.getByText(step.error as string).closest('details')?.open).toBe(false);
      expect(screen.getByText('Diagnostics')).toBeTruthy();
      expect(!!screen.queryByText('Blocker: Missing tool')).toBe(variant === 'compact');
      expect(String(fetch.mock.calls[0]?.[0])).toContain(
        '/api/v1/repositories/repo-setup/setup-blockers?includeResolved=true'
      );
    }
  );

  it('silently keeps the raw error when no row matches this workflow', async () => {
    const fetch = respond([{ ...blocker, lastWorkflowId: 'another-workflow' }]);
    const client = show('compact');
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(fetch).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { name: 'Activity failed' })).toBeTruthy();
    expect(screen.getByText(step.error as string)).toBeTruthy();
    expect(screen.queryByText(blocker.remedy)).toBeNull();
    expect(screen.queryByText('Diagnostics')).toBeNull();
    expect(screen.queryByText(/Blocker:/)).toBeNull();
  });

  it.each([403, 500])('silently keeps the raw error after HTTP %s', async (status) => {
    const fetch = respond([], status);
    const client = show('compact');
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(fetch).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { name: 'Activity failed' })).toBeTruthy();
    expect(screen.getByText(step.error as string)).toBeTruthy();
    expect(screen.queryByText(/Forbidden|could not be loaded|Blocker:/i)).toBeNull();
  });

  it('silently keeps the raw error on a network failure', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetch);
    const client = show();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(fetch).toHaveBeenCalledOnce();
    expect(screen.getByText(step.error as string)).toBeTruthy();
    expect(screen.queryByText(/offline|could not be loaded/i)).toBeNull();
  });

  it.each([{ contextSnapshot: {} }, { workflowId: '' }, { status: 'SUCCESS' as const }])(
    'does not fetch without a failed run and both identifiers (%j)',
    async (over) => {
      const fetch = respond([blocker]);
      show('compact', over);
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.getByText(step.error as string)).toBeTruthy();
    }
  );

  it('does not fetch for an unrelated failed step', () => {
    const fetch = respond([blocker]);
    show('compact', {}, { ...step, error: 'plain build error' });
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText('plain build error')).toBeTruthy();
  });
});
