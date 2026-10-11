// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ID = '11111111-1111-4111-8111-111111111111';

const state = vi.hoisted(() => ({ query: '' }));

const spec = {
  entry: 'start',
  name: 'w',
  nodes: { start: { next: 'start', step: 'noop', type: 'step' } },
  schemaVersion: 1,
};

vi.mock('next/navigation', () => ({
  usePathname: () => `/workflows/library/${ID}/diff`,
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.query),
}));
vi.mock('@/hooks/useTeams', () => ({ useLedTeamIds: () => [] }));
vi.mock('@/hooks/useTemplates', () => ({
  useWorkflowSpecDiff: (_id: string, a: number | null, b: number | null) => ({
    data: {
      a: { spec, version: a },
      b: { spec, version: b },
      diff: {
        addedNodes: [],
        changedNodes: [],
        metaChanges: [],
        presentationOnlyNodes: [],
        removedNodes: [],
        unchangedNodes: ['start'],
      },
    },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useWorkflowTemplate: () => ({
    data: {
      activeVersion: 3,
      id: ID,
      name: 'Flow',
      team: { id: 't1' },
      versions: [{ version: 1 }, { version: 3 }],
    },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/components/workflow/WorkflowDag', () => ({ WorkflowDag: () => null }));
vi.mock('@/components/workflow/PromoteVersionModal', () => ({ PromoteVersionModal: () => null }));

import TemplateDiffPage from './page';

afterEach(cleanup);

function resolvedParams<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: 'fulfilled', value });
}

function renderPage(query: string) {
  state.query = query;
  render(
    <Suspense fallback={null}>
      <TemplateDiffPage params={resolvedParams({ id: ID })} />
    </Suspense>
  );
}

describe('compare versions caption', () => {
  it('names the newer version as the added side by default', async () => {
    renderPage('');
    const text = await screen.findByText(/Added nodes exist only in v3, removed nodes only in v1/);
    expect(text.textContent).toContain('differ in at least one field');
  });

  it('names the older version as the added side when reversed', async () => {
    renderPage('reversed=1');
    expect(
      await screen.findByText(/Added nodes exist only in v1, removed nodes only in v3/)
    ).toBeTruthy();
  });
});
