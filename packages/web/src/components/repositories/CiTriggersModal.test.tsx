// @vitest-environment jsdom

import { CI_TRIAGE_INPUT_SCHEMA, triggerOptionKeys } from '@auto-swe/shared/lib/ciTrigger';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  canManage: false,
  created: [] as unknown[],
  templates: [] as unknown[],
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
    useCiTriggerTemplates: () => ({
      data: state.templates,
      isError: false,
      isLoading: false,
    }),
    useCreateCiTrigger: () => ({
      error: null,
      isError: false,
      isPending: false,
      mutate: (body: unknown) => state.created.push(body),
    }),
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

const builtIn = {
  builtIn: true,
  description: '',
  id: 'tpl-1',
  name: 'ci-triage-and-fix',
  options: {
    properties: Object.fromEntries(
      triggerOptionKeys(CI_TRIAGE_INPUT_SCHEMA).map((k) => [
        k,
        CI_TRIAGE_INPUT_SCHEMA.properties[k],
      ])
    ),
    type: 'object',
  },
};

const trigger = {
  branchPatterns: ['release/*'],
  cooldownMinutes: 30,
  createdAt: new Date().toISOString(),
  enabled: true,
  events: ['push'],
  id: 't-1',
  inputs: { mode: 'fix' },
  maxRunsPerDay: 10,
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
    state.created = [];
    state.templates = [builtIn];
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
    fireEvent.click(screen.getByRole('button', { name: /add a trigger/i }));
    expect((screen.getByLabelText('Pushes') as HTMLInputElement).checked).toBe(true);
    expect(
      (screen.getByLabelText('Pull requests from this repository') as HTMLInputElement).checked
    ).toBe(false);
    // The options come from the template's declared schema, at its defaults.
    expect(screen.getByText('Minimum confidence to fix')).toBeTruthy();
    expect((screen.getByLabelText('regression') as HTMLInputElement).checked).toBe(true);
  });

  it('saves only the options that differ from the template defaults', () => {
    state.canManage = true;
    render(<CiTriggersModal onClose={() => {}} repo={repo} />);
    fireEvent.click(screen.getByRole('button', { name: /add a trigger/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'mainline' } });
    fireEvent.click(screen.getByLabelText('dependency'));
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(state.created).toEqual([
      expect.objectContaining({
        events: ['push'],
        inputs: { fixCategories: ['regression', 'test_bug', 'configuration'] },
        name: 'mainline',
        templateId: null,
      }),
    ]);
  });

  it('answers whether a failure would match, with the gateway matcher', () => {
    state.canManage = true;
    render(<CiTriggersModal onClose={() => {}} repo={repo} />);
    fireEvent.click(screen.getByRole('button', { name: /add a trigger/i }));
    // Defaults: pushes on main and release/*.
    expect(screen.getByText(/Would start a run/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'feature/x' } });
    expect(screen.getByText(/'feature\/x' is not selected/)).toBeTruthy();
  });

  it('opens an existing trigger for editing with its saved options', () => {
    state.canManage = true;
    state.triggers = [{ ...trigger, inputs: { minFixConfidence: 0.8, mode: 'fix' } }];
    render(<CiTriggersModal onClose={() => {}} repo={repo} />);
    fireEvent.click(screen.getByRole('button', { name: /actions for release branches/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('release branches');
    expect((screen.getByLabelText(/Minimum confidence to fix/) as HTMLInputElement).value).toBe(
      '0.8'
    );
  });
});
