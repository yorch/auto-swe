// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Suspense } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';

// Stable references: the page re-seeds its editor whenever the query data identity changes.
const hooks = vi.hoisted(() => ({
  adminTeamIds: null as ReadonlySet<string> | null,
  editorProps: null as { baseVersion?: number; onChange?: (spec: unknown) => void } | null,
  ledTeamIds: new Set<string>() as ReadonlySet<string>,
  mutateAsync: vi.fn(),
  refineProps: null as { onSaved?: (v: number) => void } | null,
  template: {
    activeVersion: 1,
    description: 'Review and implement a work request.',
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
  triggerRenders: 0,
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
  versionQuery: { error: null as Error | null, isError: false, refetch: vi.fn(), undefined: false },
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
  useWorkflowTemplateVersion: () => ({
    data: hooks.versionQuery.undefined ? undefined : hooks.version,
    error: hooks.versionQuery.error,
    isError: hooks.versionQuery.isError,
    isFetching: false,
    refetch: hooks.versionQuery.refetch,
  }),
}));
vi.mock('@/hooks/useModelCatalog', () => ({ useRolePricing: () => ({ data: undefined }) }));
vi.mock('@/hooks/useTeams', () => ({
  useAdminTeamIds: () => hooks.adminTeamIds,
  useLedTeamIds: () => hooks.ledTeamIds,
}));
vi.mock('@/hooks/useTransientFlag', () => ({ useTransientFlag: () => [false, vi.fn()] }));
vi.mock('@/components/workflow/WorkflowDag', () => ({ WorkflowDag: () => null }));
vi.mock('@/components/help/PageHelp', () => ({
  PageHelp: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/workflow/TemplateEditor', () => ({
  TemplateEditor: (props: {
    actions?: React.ReactNode;
    baseVersion?: number;
    onChange?: (spec: unknown) => void;
  }) => {
    hooks.editorProps = props;
    return <div>{props.actions}</div>;
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
vi.mock('./_components/TriggersCard', () => ({
  TriggersCard: () => {
    hooks.triggerRenders += 1;
    return null;
  },
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/library/x',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { useAuthStore } from '@/stores/authStore';
import TemplateDetailPage from './page';

beforeEach(() => {
  stubDialogPrototype();
  hooks.mutateAsync.mockReset();
  hooks.mutateAsync.mockResolvedValue({ data: { version: 2 } });
  hooks.editorProps = null;
  hooks.refineProps = null;
  hooks.triggerRenders = 0;
  hooks.versionQuery.error = null;
  hooks.versionQuery.isError = false;
  hooks.versionQuery.undefined = false;
  hooks.versionQuery.refetch.mockReset();
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
  it('makes the description readable in Settings without management permissions', async () => {
    useAuthStore.setState({ user: { role: 'ENGINEER' } } as never);
    await renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
    expect(
      within(screen.getByRole('tabpanel', { name: 'Settings' })).getByText(
        hooks.template.description
      )
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /More actions for/ })).toBeNull();
  });
  it('lists the errors and blocks Activate with a visible reason', async () => {
    await renderPage();
    const activate = await screen.findByRole('button', { name: 'Activate' });
    expect((activate as HTMLButtonElement).disabled).toBe(true);
    const reason = screen.getByText(/before promoting/);
    expect(activate.getAttribute('aria-describedby')).toBe(reason.id);
    expect(screen.getByTestId('spec-errors').children.length).toBeGreaterThan(0);
  });

  it('explains immutable versions, promotion, and draft launching in page help', async () => {
    await renderPage();
    const note = await screen.findByText(/Saving creates a new immutable version/);
    expect(note.textContent).toMatch(/in-flight runs keep their launch version/);
    expect(note.textContent).toMatch(/Draft workflows cannot be launched/);
    expect(note.textContent).toMatch(/Promote changes the active version used by new runs/);
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

describe('the editor dirty model', () => {
  it('does not count opening Edit as an edit, and arms no leave prompt until the spec changes', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(hooks.editorProps).not.toBeNull());
    expect(
      (screen.getByRole('button', { name: 'Save new version' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(add.mock.calls.some(([type]) => type === 'beforeunload')).toBe(false);
    // Refine is not blocked while nothing has changed.
    expect(
      (screen.getByRole('button', { name: 'Refine with AI' }) as HTMLButtonElement).disabled
    ).toBe(false);

    act(() =>
      hooks.editorProps?.onChange?.({ ...hooks.version.spec, description: 'changed by the author' })
    );
    expect(
      (screen.getByRole('button', { name: 'Save new version' }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(add.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Refine with AI' }) as HTMLButtonElement).disabled
    ).toBe(true);
    add.mockRestore();
  });
});

describe('discarding edits', () => {
  async function openDirtyEditor() {
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(hooks.editorProps).not.toBeNull());
    act(() =>
      hooks.editorProps?.onChange?.({ ...hooks.version.spec, description: 'changed by the author' })
    );
  }

  it('asks before Cancel throws away unsaved edits, and keeps them on Keep editing', async () => {
    await openDirtyEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('dialog', { name: 'Discard your edits?' });
    // Still in edit mode until confirmed.
    expect(screen.getByRole('button', { name: 'Save new version' })).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Discard your edits?' })).getByRole('button', {
        name: 'Cancel',
      })
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Discard your edits?' })).toBeNull()
    );
    expect(screen.queryByRole('button', { name: 'Save new version' })).not.toBeNull();
  });

  it('discards the edits once confirmed', async () => {
    await openDirtyEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Save new version' })).toBeNull()
    );
  });

  it('cancels at once when nothing was changed', async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Discard your edits?' })).toBeNull();
    await screen.findByRole('button', { name: 'Edit' });
  });
});

describe('the workspace tabs', () => {
  it('keeps the settings mounted, so a webhook secret shown once survives a tab switch', async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
    const panel = screen.getByRole('tabpanel', { name: 'Settings' });
    fireEvent.click(await screen.findByRole('tab', { name: 'Definition' }));
    expect(panel.isConnected).toBe(true);
    expect(panel.className).toContain('hidden');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByRole('tabpanel', { name: 'Settings' })).toBe(panel);
    expect(panel.className).not.toContain('hidden');
  });

  it('mounts the settings only once they are first opened', async () => {
    await renderPage();
    await screen.findByRole('tab', { name: 'Settings' });
    expect(hooks.triggerRenders).toBe(0);
    expect(
      within(screen.getByRole('tabpanel', { hidden: true, name: 'Settings' })).queryByText(
        hooks.template.description
      )
    ).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(hooks.triggerRenders).toBeGreaterThan(0);
    expect(
      within(screen.getByRole('tabpanel', { name: 'Settings' })).getByText(
        hooks.template.description
      )
    ).toBeTruthy();
  });

  it('links to analytics, run history and compare from every section', async () => {
    await renderPage();
    for (const tab of ['Definition', 'Settings', 'Versions']) {
      fireEvent.click(await screen.findByRole('tab', { name: tab }));
      const reports = screen.getByRole('navigation', { name: 'Workflow reports' });
      expect(within(reports).getByRole('link', { name: 'Analytics' }).getAttribute('href')).toBe(
        `/library/${TEMPLATE_ID}/analytics`
      );
      expect(within(reports).getByRole('link', { name: 'Run history' })).toBeTruthy();
      expect(within(reports).getByRole('link', { name: 'Compare versions' })).toBeTruthy();
    }
  });

  it('says what editing will do only while editing', async () => {
    await renderPage();
    expect(screen.getByText('Read only')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByText('Editing v1 — saves as a new version')).toBeTruthy();
  });
});

describe('the selected version failing to load', () => {
  it('shows a skeleton, not the previous graph, when the selected version has not loaded', async () => {
    const view = await renderPage();
    // v1 is loaded: its definition (and lint) is on screen.
    expect(await screen.findByTestId('spec-errors')).toBeTruthy();
    expect(screen.queryByText(/Loading the definition/i)).toBeNull();
    // The newly selected version has not loaded yet.
    hooks.versionQuery.undefined = true;
    view.rerender(
      <Suspense fallback={null}>
        <TemplateDetailPage params={PARAMS} />
      </Suspense>
    );
    expect(await screen.findByText(/Loading the definition/i)).toBeTruthy();
    expect(screen.queryByTestId('spec-errors')).toBeNull();
  });

  it('says so when the workflow has no version, instead of loading forever', async () => {
    const activeVersion = hooks.template.activeVersion;
    hooks.template.activeVersion = null as never;
    hooks.versionQuery.undefined = true;
    try {
      await renderPage();
      expect(await screen.findByText('This workflow has no version yet.')).toBeTruthy();
      expect(screen.queryByText(/Loading the definition/i)).toBeNull();
      expect(screen.queryByText(/Could not load/)).toBeNull();
    } finally {
      hooks.template.activeVersion = activeVersion;
    }
  });

  it('shows the error with a Retry that refetches the version', async () => {
    hooks.versionQuery.undefined = true;
    hooks.versionQuery.isError = true;
    hooks.versionQuery.error = new Error('boom from the gateway');
    await renderPage();
    expect(await screen.findByText('Could not load v1')).toBeTruthy();
    expect(screen.getByText('boom from the gateway')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(hooks.versionQuery.refetch).toHaveBeenCalledTimes(1);
  });
});

describe('error titles', () => {
  async function saveWith(failure: Error) {
    hooks.mutateAsync.mockRejectedValue(failure);
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'JSON' }));
    const box = screen.getByLabelText('Raw JSON') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: `${box.value}\n` } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save new version' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(hooks.mutateAsync).toHaveBeenCalledTimes(1));
    return box;
  }

  it('titles a failed request "Could not save" and clears it once the text changes', async () => {
    const box = await saveWith(new Error('network down'));
    expect(await screen.findByText('Could not save')).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();
    fireEvent.change(box, { target: { value: `${box.value} ` } });
    await waitFor(() => expect(screen.queryByText('Could not save')).toBeNull());
  });

  it('shows the advisory warnings of a saved version', async () => {
    hooks.mutateAsync.mockResolvedValue({
      data: { version: 2 },
      warnings: ['agent reference "ghost" was not found'],
    });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'JSON' }));
    const box = screen.getByLabelText('Raw JSON') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: `${box.value}\n` } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save new version' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Saved with warnings')).toBeTruthy();
    expect(screen.getByText('agent reference "ghost" was not found')).toBeTruthy();
  });
});

describe('the warnings of a saved version', () => {
  it('drop away when another version is viewed', async () => {
    hooks.template.versions = [
      { createdAt: '2026-01-01T00:00:00.000Z', version: 1 },
      { createdAt: '2026-01-02T00:00:00.000Z', version: 2 },
    ];
    hooks.mutateAsync.mockResolvedValue({ data: { version: 2 }, warnings: ['heads up'] });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'JSON' }));
    const box = screen.getByLabelText('Raw JSON') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: `${box.value}\n` } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save new version' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('heads up')).toBeTruthy();
    fireEvent.click(await screen.findByRole('tab', { name: 'Versions' }));
    const rows = within(screen.getByRole('tabpanel', { name: 'Versions' })).getAllByRole('button');
    const v1 = rows.find((row) => /^v1/.test(row.textContent ?? ''));
    expect(v1).toBeTruthy();
    if (v1) {
      fireEvent.click(v1);
    }
    await waitFor(() => expect(screen.queryByText('heads up')).toBeNull());
  });
});

describe('leaving the JSON view', () => {
  it('stays in JSON while the text does not parse, and says why', async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'JSON' }));
    fireEvent.change(screen.getByLabelText('Raw JSON'), { target: { value: '{ not json' } });
    expect(screen.getByText('Fix the JSON, or Cancel, to switch to Visual')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    expect((screen.getByLabelText('Raw JSON') as HTMLTextAreaElement).value).toBe('{ not json');
  });

  it('lets an untouched, unparseable stored version switch to Visual, even read-only', async () => {
    useAuthStore.setState({ user: { role: 'ENGINEER' } } as never);
    const stored = hooks.version.spec;
    hooks.version.spec = { broken: true } as unknown as typeof stored;
    try {
      await renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'JSON' }));
      expect(screen.getByLabelText('Raw JSON')).toBeTruthy();
      expect(screen.queryByText('Fix the JSON, or Cancel, to switch to Visual')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
      expect(await screen.findByText('This version cannot be drawn')).toBeTruthy();
      expect(screen.queryByLabelText('Raw JSON')).toBeNull();
    } finally {
      hooks.version.spec = stored;
    }
  });
});
