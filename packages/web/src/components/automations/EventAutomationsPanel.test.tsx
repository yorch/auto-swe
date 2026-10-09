// @vitest-environment jsdom

import { optionsSchema, workflowRunFailedSource } from '@auto-swe/shared/automation';
import { CI_TRIAGE_INPUT_SCHEMA } from '@auto-swe/shared/lib/ciTrigger';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  automations: [] as unknown[],
  canManage: false,
  created: [] as unknown[],
  templates: [] as unknown[],
  updated: [] as unknown[],
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/hooks/useAutomations', () => {
  const mutation = () => ({ error: null, isError: false, isPending: false, mutate: vi.fn() });
  return {
    useAutomationFires: () => ({ data: [], isError: false, isLoading: false }),
    useAutomationTemplates: () => ({ data: state.templates, isError: false, isLoading: false }),
    useCreateEventAutomation: () => ({
      error: null,
      isError: false,
      isPending: false,
      mutate: (body: unknown) => state.created.push(body),
    }),
    useDeleteEventAutomation: mutation,
    useEventAutomations: () => ({
      data: { automations: state.automations, canManage: state.canManage },
      isError: false,
      isLoading: false,
    }),
    useRetryAutomationFire: mutation,
    useUpdateEventAutomation: () => ({
      error: null,
      isError: false,
      isPending: false,
      mutate: (body: unknown) => state.updated.push(body),
    }),
  };
});

import { EventAutomationsPanel } from './EventAutomationsPanel';

const builtIn = {
  builtIn: true,
  description: '',
  id: 'tpl-1',
  name: 'ci-triage-and-fix',
  options: optionsSchema(CI_TRIAGE_INPUT_SCHEMA, workflowRunFailedSource),
};

const automation = {
  connectionId: 'r-1',
  cooldownMinutes: 30,
  createdAt: new Date().toISOString(),
  enabled: true,
  filters: {
    branchPatterns: ['release/*'],
    events: ['push'],
    workflowPatterns: ['.github/workflows/**'],
  },
  id: 'a-1',
  inputs: { mode: 'fix' },
  maxRunsPerDay: 10,
  name: 'release branches',
  source: 'github.workflow_run.failed',
  template: null,
  templateId: null,
};

const ADD = /when ci fails/i;

describe('EventAutomationsPanel', () => {
  beforeEach(() => {
    state.canManage = false;
    state.created = [];
    state.updated = [];
    state.templates = [builtIn];
    state.automations = [];
  });

  it('says a repository with no automation starts nothing', () => {
    render(<EventAutomationsPanel connectionId="r-1" />);
    expect(screen.getByText(/no event automations/i)).toBeTruthy();
  });

  it('shows a member the automations but no way to add one', () => {
    state.automations = [automation];
    render(<EventAutomationsPanel connectionId="r-1" />);
    expect(screen.getByText('release branches')).toBeTruthy();
    expect(screen.getByText(/Diagnose and draft a fix/)).toBeTruthy();
    expect(screen.getByText(/pushes on release\/\*/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: ADD })).toBeNull();
    expect((screen.getByRole('switch', { hidden: true }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers a manager the form for a source, from its descriptor and its template', () => {
    state.canManage = true;
    render(<EventAutomationsPanel connectionId="r-1" />);
    fireEvent.click(screen.getByRole('button', { name: ADD }));
    expect((screen.getByLabelText('Pushes') as HTMLInputElement).checked).toBe(true);
    expect(
      (screen.getByLabelText('Pull requests from this repository') as HTMLInputElement).checked
    ).toBe(false);
    // The options come from the template's declared schema, at its defaults.
    expect(screen.getByText('Minimum confidence to fix')).toBeTruthy();
    expect((screen.getByLabelText('regression') as HTMLInputElement).checked).toBe(true);
  });

  it('saves the source, its filters, and only the options that differ from the defaults', () => {
    state.canManage = true;
    render(<EventAutomationsPanel connectionId="r-1" />);
    fireEvent.click(screen.getByRole('button', { name: ADD }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'mainline' } });
    fireEvent.click(screen.getByLabelText('dependency'));
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(state.created).toEqual([
      expect.objectContaining({
        filters: {
          branchPatterns: ['main', 'release/*'],
          events: ['push'],
          workflowPatterns: ['.github/workflows/**'],
        },
        inputs: { fixCategories: ['regression', 'test_bug', 'configuration'] },
        name: 'mainline',
        source: 'github.workflow_run.failed',
        templateId: null,
      }),
    ]);
  });

  it('answers whether an occurrence would match, with the source’s own matcher', () => {
    state.canManage = true;
    render(<EventAutomationsPanel connectionId="r-1" />);
    fireEvent.click(screen.getByRole('button', { name: ADD }));
    expect(screen.getByText(/Would start a run/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'feature/x' } });
    expect(screen.getByText(/'feature\/x' is not selected/)).toBeTruthy();
  });

  it('opens an existing automation for editing, and never sends its on/off switch', () => {
    state.canManage = true;
    state.automations = [{ ...automation, inputs: { minFixConfidence: 0.8, mode: 'fix' } }];
    render(<EventAutomationsPanel connectionId="r-1" />);
    fireEvent.click(screen.getByRole('button', { name: /actions for release branches/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('release branches');
    expect((screen.getByLabelText(/Minimum confidence to fix/) as HTMLInputElement).value).toBe(
      '0.8'
    );
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(state.updated).toHaveLength(1);
    expect(state.updated[0]).not.toHaveProperty('enabled');
    expect(state.updated[0]).toMatchObject({
      id: 'a-1',
      inputs: { minFixConfidence: 0.8, mode: 'fix' },
    });
  });
});
