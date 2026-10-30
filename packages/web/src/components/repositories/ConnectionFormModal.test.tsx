// @vitest-environment jsdom

import { detectStack } from '@auto-swe/shared/lib/stackDetection';
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const auth = vi.hoisted(() => ({ role: 'LEAD', teamRole: 'LEAD' as 'LEAD' | 'ADMIN' }));
const update = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
const create = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (select: (s: { user: { role: string } }) => unknown) =>
    select({ user: { role: auth.role } }),
}));
vi.mock('@/hooks/useTeams', () => ({
  useAdminTeamIds: () => new Set(auth.teamRole === 'ADMIN' ? ['t1'] : []),
  useLedTeamIds: () => new Set(['t1']),
  useTeams: () => ({ data: [{ id: 't1', name: 'Payments' }] }),
}));
vi.mock('@/hooks/useRepositories', () => ({
  useCreateRepository: () => ({ isPending: false, mutateAsync: create.mutateAsync }),
  useUpdateRepository: () => ({ isPending: false, mutateAsync: update.mutateAsync }),
}));

import { ConnectionFormModal } from './ConnectionFormModal';

const repo = {
  _count: { activeWorkflows: 0 },
  config: null,
  consolidationEnabled: true,
  defaultBranch: 'main',
  description: null,
  executorImage: null,
  gateCommands: { runTests: 'npm test' },
  id: 'r1',
  isActive: true,
  language: null,
  name: null,
  organizationName: 'acme',
  repoName: 'payments-api',
  team: { id: 't1', name: 'Payments', slug: 'payments' },
  type: 'git_repo',
} as unknown as RepositorySummary;

function renderEdit(initial = repo) {
  render(<ConnectionFormModal mode={{ kind: 'edit', repo: initial }} onClose={() => {}} open />);
}

const testsField = () => screen.getByLabelText('Tests') as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

describe('ConnectionFormModal gate commands', () => {
  beforeAll(() => stubDialogPrototype());
  beforeEach(() => {
    update.mutateAsync.mockReset().mockResolvedValue({});
    create.mutateAsync.mockReset().mockResolvedValue({});
    auth.role = 'LEAD';
    auth.teamRole = 'LEAD';
  });

  it('shows a team lead the stored commands read-only, and saves without them', async () => {
    renderEdit();
    expect(testsField().value).toBe('npm test');
    expect(testsField().disabled).toBe(true);
    expect(
      screen.getByText(/needs a platform admin or an admin of the repository's team/)
    ).toBeTruthy();
    save();
    await waitFor(() => expect(update.mutateAsync).toHaveBeenCalled());
    expect(update.mutateAsync.mock.calls[0]?.[0]).not.toHaveProperty('gateCommands');
  });

  it('lets a team admin change them and sends the full set', async () => {
    auth.teamRole = 'ADMIN';
    renderEdit();
    expect(testsField().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Lint'), { target: { value: 'pnpm lint' } });
    save();
    await waitFor(() => expect(update.mutateAsync).toHaveBeenCalled());
    expect(update.mutateAsync.mock.calls[0]?.[0].gateCommands).toEqual({
      runLint: 'pnpm lint',
      runTests: 'npm test',
    });
  });

  it('lets a team admin save an app preview recipe from JSON', async () => {
    auth.teamRole = 'ADMIN';
    renderEdit();
    fireEvent.change(screen.getByLabelText('App preview (UI validation)'), {
      target: { value: JSON.stringify({ readyUrl: 'http://localhost:3000', start: 'npm start' }) },
    });
    save();

    await waitFor(() => expect(update.mutateAsync).toHaveBeenCalled());
    expect(update.mutateAsync.mock.calls[0]?.[0].previewConfig).toEqual({
      readyUrl: 'http://localhost:3000',
      start: 'npm start',
    });
  });

  it('clears a saved preview recipe when its JSON field is empty', async () => {
    auth.teamRole = 'ADMIN';
    renderEdit({
      ...repo,
      previewConfig: {
        baseUrl: 'http://localhost:3000',
        readyTimeoutMs: 180_000,
        readyUrl: 'http://localhost:3000',
        start: 'npm start',
      },
    });
    fireEvent.change(screen.getByLabelText('App preview (UI validation)'), {
      target: { value: '' },
    });
    save();

    await waitFor(() => expect(update.mutateAsync).toHaveBeenCalled());
    expect(update.mutateAsync.mock.calls[0]?.[0].previewConfig).toBeNull();
  });

  it('shows server validation errors for an invalid app preview recipe', async () => {
    auth.teamRole = 'ADMIN';
    update.mutateAsync.mockRejectedValueOnce(new Error('readyUrl must use localhost'));
    renderEdit();
    fireEvent.change(screen.getByLabelText('App preview (UI validation)'), {
      target: { value: JSON.stringify({ readyUrl: 'https://example.com', start: 'npm start' }) },
    });
    save();

    expect(await screen.findByText('readyUrl must use localhost')).toBeTruthy();
  });

  describe('onboarding', () => {
    function renderCreate() {
      render(
        <ConnectionFormModal
          mode={{ kind: 'create', prefill: { organizationName: 'acme', repoName: 'api' } }}
          onClose={() => {}}
          open
        />
      );
    }
    const createButton = () => screen.getByRole('button', { name: 'Create connection' });

    it("sends a team admin's commands with the new repository", async () => {
      auth.teamRole = 'ADMIN';
      renderCreate();
      fireEvent.change(screen.getByLabelText('Tests'), { target: { value: 'npm test' } });
      fireEvent.click(createButton());
      await waitFor(() => expect(create.mutateAsync).toHaveBeenCalled());
      expect(create.mutateAsync.mock.calls[0]?.[0].gateCommands).toEqual({ runTests: 'npm test' });
    });

    it('sends none for a team lead, whose fields are read-only', async () => {
      renderCreate();
      expect((screen.getByLabelText('Tests') as HTMLInputElement).disabled).toBe(true);
      fireEvent.click(createButton());
      await waitFor(() => expect(create.mutateAsync).toHaveBeenCalled());
      expect(create.mutateAsync.mock.calls[0]?.[0]).not.toHaveProperty('gateCommands');
    });
  });
});

describe('ConnectionFormModal detected stack coverage', () => {
  beforeAll(() => stubDialogPrototype());
  beforeEach(() => {
    auth.role = 'LEAD';
    auth.teamRole = 'LEAD';
  });

  function renderWithDetection(files: string[]) {
    const detectedStack = detectStack(files);
    render(
      <ConnectionFormModal
        mode={{ kind: 'edit', repo: { ...repo, detectedStack } }}
        onClose={() => {}}
        open
      />
    );
  }

  it('says which components the default gates do not cover', () => {
    renderWithDetection(['package.json', 'svc/requirements.txt']);
    expect(screen.getByText(/Not covered: svc \(python\)\./)).toBeTruthy();
    expect(screen.getByText(/Default gates cover the repository root only/)).toBeTruthy();
  });

  it('lists at most five, then counts the rest', () => {
    renderWithDetection([
      'package.json',
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((p) => `${p}/requirements.txt`),
    ]);
    expect(
      screen.getByText(
        /a \(python\), b \(python\), c \(python\), d \(python\), e \(python\), and 2 more\./
      )
    ).toBeTruthy();
  });

  it('counts the rest below the cap', () => {
    renderWithDetection([
      'package.json',
      ...Array.from({ length: 8 }, (_, i) => `s${i}/requirements.txt`),
    ]);
    expect(screen.getByText(/, and 3 more\./)).toBeTruthy();
  });

  it('says "and more", not a number, once the list is capped', () => {
    renderWithDetection([
      'package.json',
      ...Array.from({ length: 25 }, (_, i) => `s${String(i).padStart(2, '0')}/requirements.txt`),
    ]);
    expect(screen.getByText(/, and more\./)).toBeTruthy();
    expect(screen.queryByText(/and \d+ more/)).toBeNull();
  });

  it('says nothing when the root covers every component', () => {
    renderWithDetection(['package.json', 'packages/a/package.json']);
    expect(screen.queryByText(/Not covered/)).toBeNull();
  });
});
