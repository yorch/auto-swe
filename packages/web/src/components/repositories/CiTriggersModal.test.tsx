// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  canManage: false,
  triggers: [] as unknown[],
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/hooks/useCiTriggers', () => {
  const mutation = () => ({ error: null, isError: false, isPending: false, mutate: vi.fn() });
  return {
    useCiTriggerFires: () => ({ data: [], isError: false, isLoading: false }),
    useCiTriggers: () => ({
      data: { canManage: state.canManage, triggers: state.triggers },
      isError: false,
      isLoading: false,
    }),
    useCreateCiTrigger: mutation,
    useDeleteCiTrigger: mutation,
    useUpdateCiTrigger: mutation,
  };
});

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { CiTriggersModal } from './CiTriggersModal';

const repo = {
  id: 'r-1',
  name: null,
  organizationName: 'acme',
  repoName: 'api',
} as unknown as RepositorySummary;

const trigger = {
  branchPatterns: ['release/*'],
  commentOnPullRequest: true,
  cooldownMinutes: 30,
  createdAt: new Date().toISOString(),
  enabled: true,
  events: ['push'],
  id: 't-1',
  maxRunsPerDay: 10,
  mode: 'FIX',
  name: 'release branches',
  template: null,
  templateId: null,
  workflowPatterns: ['.github/workflows/**'],
};

// jsdom implements <dialog> without showModal()/close().
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

describe('CiTriggersModal', () => {
  beforeEach(() => {
    state.canManage = false;
    state.triggers = [];
  });

  it('says a repository with no trigger starts nothing', () => {
    render(<CiTriggersModal onClose={() => {}} repo={repo} />);
    expect(screen.getByText(/no triggers/i)).toBeTruthy();
  });

  it('shows a member the triggers but no way to add one', () => {
    state.triggers = [trigger];
    render(<CiTriggersModal onClose={() => {}} repo={repo} />);
    expect(screen.getByText('release branches')).toBeTruthy();
    expect(screen.getByText(/Diagnose and draft a fix/)).toBeTruthy();
    expect(screen.queryByText('Add a trigger')).toBeNull();
    expect((screen.getByRole('switch', { hidden: true }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers a manager the form, defaulting to diagnose-only on pushes', () => {
    state.canManage = true;
    render(<CiTriggersModal onClose={() => {}} repo={repo} />);
    expect(screen.getByText('Add a trigger')).toBeTruthy();
    expect((screen.getByLabelText('Pushes') as HTMLInputElement).checked).toBe(true);
    expect(
      (screen.getByLabelText('Pull requests from this repository') as HTMLInputElement).checked
    ).toBe(false);
  });
});
