// @vitest-environment jsdom

import {
  JIRA_FILTER_NEW_ISSUE,
  jiraFilterNewIssueSource,
  optionsSchema,
  workflowRunFailedSource,
} from '@auto-swe/shared/automation';
import { CI_TRIAGE_INPUT_SCHEMA } from '@auto-swe/shared/lib/ciTrigger';
import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
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
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
    expect(screen.getByText(/no event automations/i)).toBeTruthy();
  });

  it('offers a team’s manager only sources whose automations belong to a team', () => {
    state.canManage = true;
    render(<EventAutomationsPanel owner={{ teamId: 't-1' }} />);
    expect(screen.getByText(/nothing that happens for this team/i)).toBeTruthy();
    // Every shipped source lives on a repository.
    expect(screen.queryByRole('button', { name: ADD })).toBeNull();
    expect(screen.queryByRole('button', { name: /issue is labelled/i })).toBeNull();
  });

  it('shows a member the automations but no way to add one', () => {
    state.automations = [automation];
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
    expect(screen.getByText('release branches')).toBeTruthy();
    expect(screen.getByText(/Diagnose and draft a fix/)).toBeTruthy();
    expect(screen.getByText(/pushes on release\/\*/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: ADD })).toBeNull();
    expect((screen.getByRole('switch', { hidden: true }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers a manager the form for a source, from its descriptor and its template', () => {
    state.canManage = true;
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
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
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
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
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
    fireEvent.click(screen.getByRole('button', { name: ADD }));
    expect(screen.getByText(/Would start a run/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'feature/x' } });
    expect(screen.getByText(/'feature\/x' is not selected/)).toBeTruthy();
  });

  it('opens an existing automation for editing, and never sends its on/off switch', () => {
    state.canManage = true;
    state.automations = [{ ...automation, inputs: { minFixConfidence: 0.8, mode: 'fix' } }];
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
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

describe('EventAutomationsPanel: Jira filter automations', () => {
  const JQL = 'status in ("To Do", "In Progress") AND project = PAY ORDER BY created';
  const JIRA_TEMPLATE_SCHEMA: InputSchema = {
    properties: {
      connectionId: { connectionType: 'git_repo', type: 'connection' },
      description: { type: 'string' },
      ticketId: { type: 'string' },
    },
    required: ['connectionId', 'description', 'ticketId'],
    type: 'object',
  };
  const jira = {
    ...automation,
    filters: { jql: JQL },
    id: 'j-1',
    inputs: {},
    name: 'new tickets',
    pollState: null as null | Record<string, unknown>,
    source: JIRA_FILTER_NEW_ISSUE,
  };

  beforeEach(() => {
    state.canManage = true;
    state.created = [];
    state.updated = [];
    state.automations = [];
    state.templates = [
      {
        builtIn: true,
        description: '',
        id: 'tpl-j',
        name: 'ticket-to-merge',
        options: optionsSchema(JIRA_TEMPLATE_SCHEMA, jiraFilterNewIssueSource),
      },
    ];
  });

  it('offers a manager the source, with the JQL as a text box', () => {
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
    fireEvent.click(screen.getByRole('button', { name: /jira filter has a new issue/i }));
    const box = screen.getByLabelText('JQL') as HTMLTextAreaElement;
    expect(box.tagName).toBe('TEXTAREA');
    expect(box.value).toBe('');
  });

  it('saves the JQL exactly as typed: one string, its commas and parentheses intact', () => {
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
    fireEvent.click(screen.getByRole('button', { name: /jira filter has a new issue/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'new tickets' } });
    fireEvent.change(screen.getByLabelText('JQL'), { target: { value: JQL } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(state.created).toEqual([
      expect.objectContaining({ filters: { jql: JQL }, source: JIRA_FILTER_NEW_ISSUE }),
    ]);
  });

  it('shows a saved JQL when editing, and saves it back unchanged', () => {
    state.automations = [jira];
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
    fireEvent.click(screen.getByRole('button', { name: /actions for new tickets/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect((screen.getByLabelText('JQL') as HTMLTextAreaElement).value).toBe(JQL);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(state.updated[0]).toMatchObject({ filters: { jql: JQL }, id: 'j-1' });
  });

  it('offers no "would this match" tester, since the JQL is Jira’s to evaluate', () => {
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
    fireEvent.click(screen.getByRole('button', { name: /jira filter has a new issue/i }));
    expect(screen.queryByText(/would start a run/i)).toBeNull();
    expect(screen.queryByLabelText('Issue key')).toBeNull();
  });

  it('says an enabled automation has not been polled yet', () => {
    state.automations = [jira];
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
    expect(screen.getByText(/not polled yet/i)).toBeTruthy();
  });

  it('says when it was last polled', () => {
    state.automations = [
      {
        ...jira,
        pollState: {
          baselinedAt: new Date().toISOString(),
          lastError: null,
          lastPolledAt: new Date().toISOString(),
        },
      },
    ];
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
    expect(screen.getByText(/last polled/i)).toBeTruthy();
    expect(screen.queryByText(/not polled yet/i)).toBeNull();
  });

  it.each([
    ['NO_ALLOWED_PROJECTS', /no jira project is allowed/i],
    ['FILTER_TOO_BROAD', /more than 1,000 issues/i],
    ['JQL_REJECTED', /jira refused the jql/i],
    ['TRACKER_UNAVAILABLE', /could not be reached/i],
    ['INVALID_FILTERS', /saved jql is not valid/i],
    ['START_FAILED', /could not be started/i],
  ])('explains the poll error %s in words', (code, words) => {
    state.automations = [
      {
        ...jira,
        pollState: {
          baselinedAt: new Date().toISOString(),
          lastError: code,
          lastPolledAt: new Date().toISOString(),
        },
      },
    ];
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
    expect(screen.getByText(words)).toBeTruthy();
  });

  it('shows an error code it does not know as it is', () => {
    state.automations = [
      { ...jira, pollState: { baselinedAt: null, lastError: 'SOMETHING_NEW', lastPolledAt: null } },
    ];
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
    expect(screen.getByText(/SOMETHING_NEW/)).toBeTruthy();
  });

  it('does not mistake an inherited object key for a known error code', () => {
    state.automations = [
      { ...jira, pollState: { baselinedAt: null, lastError: 'constructor', lastPolledAt: null } },
    ];
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
    expect(screen.getByText('Last poll failed: constructor')).toBeTruthy();
  });

  it('says nothing about polling for a disabled automation or another source', () => {
    state.automations = [
      { ...jira, enabled: false },
      { ...automation, id: 'c-1', name: 'ci rule' },
    ];
    render(<EventAutomationsPanel owner={{ connectionId: 'r-1' }} />);
    expect(screen.queryByText(/polled/i)).toBeNull();
  });
});
