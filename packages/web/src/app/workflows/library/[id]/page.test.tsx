// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';

// Stable references: the page re-seeds its editor whenever the query data identity changes.
const hooks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  template: {
    activeVersion: 1,
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Broken',
    status: 'DRAFT',
    team: { id: 't1' },
    versions: [{ createdAt: '2026-01-01T00:00:00.000Z', version: 1 }],
  },
  version: {
    generatedBy: null,
    reviewedAt: null,
    spec: {
      entry: 'start',
      name: 'broken',
      // Parses, but nothing in it can end: the one lint error the server lets through.
      nodes: { start: { next: 'start', step: 'noop', type: 'step' } },
      schemaVersion: 1,
    },
    version: 1,
  },
}));

const idle = { isError: false, isLoading: false, isPending: false, mutateAsync: vi.fn() };
vi.mock('@/hooks/useTemplates', () => ({
  useCreateWorkflowVersion: () => ({ ...idle, mutateAsync: hooks.mutateAsync }),
  useExplainWorkflowTemplate: () => idle,
  useRegenerateWebhook: () => idle,
  useReviewWorkflowVersion: () => idle,
  useRevokeWebhook: () => idle,
  useStepRegistry: () => ({ data: [] }),
  useUpdateWorkflowTemplate: () => idle,
  useWorkflowSpecDiff: () => ({ data: undefined, isLoading: false }),
  useWorkflowTemplate: () => ({
    data: hooks.template,
    error: null,
    isError: false,
    isLoading: false,
  }),
  useWorkflowTemplateAnalytics: () => ({ data: undefined }),
  useWorkflowTemplateVersion: () => ({ data: hooks.version }),
}));
vi.mock('@/hooks/useModelCatalog', () => ({ useRolePricing: () => ({ data: undefined }) }));
vi.mock('@/hooks/useTeams', () => ({ useLedTeamIds: () => [] }));
vi.mock('@/hooks/useTransientFlag', () => ({ useTransientFlag: () => [false, vi.fn()] }));
vi.mock('@/components/workflow/WorkflowDag', () => ({ WorkflowDag: () => null }));
vi.mock('@/components/workflow/TemplateEditor', () => ({ TemplateEditor: () => null }));
vi.mock('@/components/workflow/RunTemplateModal', () => ({ RunTemplateModal: () => null }));
vi.mock('@/components/workflow/RefineChatPanel', () => ({ RefineChatPanel: () => null }));
vi.mock('@/components/workflow/PromoteVersionModal', () => ({ PromoteVersionModal: () => null }));
vi.mock('@/components/workflow/templateNav', () => ({
  TemplateBackLink: () => null,
  TemplateNotFound: () => null,
  TemplateSubNav: () => null,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { useAuthStore } from '@/stores/authStore';
import TemplateDetailPage from './page';

beforeEach(() => {
  stubDialogPrototype();
  hooks.mutateAsync.mockReset();
  hooks.mutateAsync.mockResolvedValue({ data: { version: 2 } });
  useAuthStore.setState({ user: { role: 'ADMIN' } } as never);
});

// React's `use` reads a settled thenable synchronously; a fresh promise per render would suspend forever.
const PARAMS = Object.assign(Promise.resolve({ id: TEMPLATE_ID }), {
  status: 'fulfilled',
  value: { id: TEMPLATE_ID },
});

async function renderPage() {
  render(
    <Suspense fallback={null}>
      <TemplateDetailPage params={PARAMS} />
    </Suspense>
  );
}

describe('workflow editor with lint errors', () => {
  it('lists the errors and blocks Activate with a visible reason', async () => {
    await renderPage();
    const activate = await screen.findByRole('button', { name: 'Activate' });
    expect((activate as HTMLButtonElement).disabled).toBe(true);
    const reason = screen.getByText(/before promoting/);
    expect(activate.getAttribute('aria-describedby')).toBe(reason.id);
    expect(screen.getByTestId('spec-errors').children.length).toBeGreaterThan(0);
  });

  it('keeps Save enabled in JSON mode, asks first, then saves the draft', async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'JSON' }));
    // Touch the text so the editor counts as dirty.
    const box = screen.getByLabelText('Raw JSON') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: `${box.value}\n` } });
    expect(screen.getByTestId('spec-errors')).toBeTruthy();
    const save = await screen.findByRole('button', { name: 'Save new version' });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await screen.findByText(/Save draft with \d+ error/);
    expect(hooks.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(hooks.mutateAsync).toHaveBeenCalledTimes(1));
  });
});
