// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';

// Stable references: the page re-seeds its editor whenever the query data identity changes.
const hooks = vi.hoisted(() => ({
  adminTeamIds: null as ReadonlySet<string> | null,
  editorProps: null as { baseVersion?: number } | null,
  ledTeamIds: new Set<string>() as ReadonlySet<string>,
  mutateAsync: vi.fn(),
  refineProps: null as { onSaved?: (v: number) => void } | null,
  template: {
    activeVersion: 1,
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Broken',
    status: 'DRAFT',
    team: { id: 't1' },
    versions: [{ createdAt: '2026-01-01T00:00:00.000Z', version: 1 }],
    webhookSignatureRequiredByPolicy: false,
    webhookSigning: {
      configured: false,
      lastFour: null,
      previousExpiresAt: null,
      requireSignature: false,
    },
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
  useRemoveWebhookSigningSecret: () => idle,
  useReviewWorkflowVersion: () => idle,
  useRevokeWebhook: () => idle,
  useRotateWebhookSigningSecret: () => idle,
  useSetWebhookRequireSignature: () => idle,
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
vi.mock('@/hooks/useTeams', () => ({
  useAdminTeamIds: () => hooks.adminTeamIds,
  useLedTeamIds: () => hooks.ledTeamIds,
}));
vi.mock('@/hooks/useTransientFlag', () => ({ useTransientFlag: () => [false, vi.fn()] }));
vi.mock('@/components/workflow/WorkflowDag', () => ({ WorkflowDag: () => null }));
vi.mock('@/components/workflow/TemplateEditor', () => ({
  TemplateEditor: (props: { baseVersion?: number }) => {
    hooks.editorProps = props;
    return null;
  },
}));
vi.mock('@/components/workflow/RefineChatPanel', () => ({
  RefineChatPanel: (props: { onSaved?: (v: number) => void }) => {
    hooks.refineProps = props;
    return null;
  },
}));
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
  hooks.editorProps = null;
  hooks.refineProps = null;
  hooks.template.versions = [{ createdAt: '2026-01-01T00:00:00.000Z', version: 1 }];
  hooks.adminTeamIds = null;
  hooks.ledTeamIds = new Set();
  useAuthStore.setState({ user: { role: 'ADMIN' } } as never);
});

// React's `use` reads a settled thenable synchronously; a fresh promise per render would suspend forever.
const PARAMS = Object.assign(Promise.resolve({ id: TEMPLATE_ID }), {
  status: 'fulfilled',
  value: { id: TEMPLATE_ID },
});

const tree = (
  <Suspense fallback={null}>
    <TemplateDetailPage params={PARAMS} />
  </Suspense>
);

async function renderPage() {
  return render(tree);
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

  it('says saving makes an immutable version and defines Draft, Active and Promote', async () => {
    await renderPage();
    const note = await screen.findByText(/Saving creates a new immutable version/);
    expect(note.textContent).toMatch(/in flight stay on the version they started with/);
    expect(note.textContent).toMatch(/Draft\s*means the template cannot be launched yet/);
    expect(note.textContent).toMatch(/Promote\s*makes a version the active one/);
    expect(screen.getByRole('button', { name: 'What is a version?' })).toBeTruthy();
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

describe('saving a version with an authored command', () => {
  const LINT_COMMAND_SPEC = {
    entry: 'lint',
    name: 'broken',
    nodes: {
      done: { status: 'SUCCESS', type: 'terminate' },
      lint: { config: { command: 'npm run lint' }, next: 'done', step: 'runLint', type: 'step' },
    },
    schemaVersion: 1,
  };

  async function saveJson(spec: object) {
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'JSON' }));
    fireEvent.change(screen.getByLabelText('Raw JSON'), {
      target: { value: JSON.stringify(spec, null, 2) },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Save new version' }));
  }

  it('tells a team lead who is not a team admin, without asking the server', async () => {
    useAuthStore.setState({ user: { role: 'LEAD' } } as never);
    hooks.ledTeamIds = new Set(['t1']);
    hooks.adminTeamIds = new Set();
    await saveJson(LINT_COMMAND_SPEC);
    expect(
      await screen.findByText(/1 step with its own command\. Needs a platform admin/)
    ).toBeTruthy();
    expect(hooks.mutateAsync).not.toHaveBeenCalled();
  });

  it('asks a team admin to confirm, then saves', async () => {
    useAuthStore.setState({ user: { role: 'LEAD' } } as never);
    hooks.ledTeamIds = new Set(['t1']);
    hooks.adminTeamIds = new Set(['t1']);
    await saveJson(LINT_COMMAND_SPEC);
    await screen.findByText('Authored code detected');
    expect(hooks.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save with authored code' }));
    await waitFor(() => expect(hooks.mutateAsync).toHaveBeenCalledTimes(1));
  });
});

describe('the base version Check workflow is given', () => {
  const at = (version: number) => ({ createdAt: '2026-01-01T00:00:00.000Z', version });

  async function openEditor() {
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(hooks.editorProps).not.toBeNull());
  }

  it('is the newest version at load, so drafts above the active version are not stale', async () => {
    hooks.template.versions = [at(1), at(2), at(3)];
    await renderPage();
    await openEditor();
    // The active version is 1; versions 2 and 3 were already there.
    expect(hooks.editorProps?.baseVersion).toBe(3);
  });

  it('does not move when a newer version appears, so the server can report it', async () => {
    hooks.template.versions = [at(1), at(2)];
    const view = await renderPage();
    await openEditor();
    expect(hooks.editorProps?.baseVersion).toBe(2);
    // Another tab saves version 3; the query refetches and the page renders again.
    hooks.template.versions = [at(1), at(2), at(3)];
    view.rerender(tree);
    expect(hooks.editorProps?.baseVersion).toBe(2);
  });

  it('includes a version this page saved itself', async () => {
    hooks.template.versions = [at(1), at(2)];
    hooks.mutateAsync.mockResolvedValue({ data: { version: 3 } });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'JSON' }));
    const box = screen.getByLabelText('Raw JSON') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: `${box.value}\n` } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save new version' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(hooks.mutateAsync).toHaveBeenCalledTimes(1));
    hooks.template.versions = [at(1), at(2), at(3)];
    await waitFor(() => expect(screen.queryByLabelText('Raw JSON')).toBeNull());
    await openEditor();
    expect(hooks.editorProps?.baseVersion).toBe(3);
  });

  it('includes a version a refinement saved', async () => {
    hooks.template.versions = [at(1), at(2)];
    await renderPage();
    await screen.findByRole('button', { name: 'Edit' });
    act(() => hooks.refineProps?.onSaved?.(3));
    hooks.template.versions = [at(1), at(2), at(3)];
    await openEditor();
    expect(hooks.editorProps?.baseVersion).toBe(3);
  });
});
