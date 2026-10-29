// @vitest-environment jsdom
import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { WorkflowLaunchForm } from './WorkflowLaunchForm';

const template = {
  activeVersion: 2,
  createdAt: '',
  description: 'Produces a short summary.',
  experimentSplit: null,
  experimentVersion: null,
  id: 'template-1',
  inputSchema: {
    properties: { description: { type: 'string' } },
    required: ['description'],
    type: 'object',
  },
  isDefault: false,
  lastRun: null,
  name: 'Write a summary',
  status: 'ACTIVE',
  team: null,
  updatedAt: '',
  versionCount: 2,
  webhookConfigured: false,
  webhookSigning: {
    configured: false,
    lastFour: null,
    previousExpiresAt: null,
    requireSignature: false,
  },
} satisfies WorkflowTemplateSummary;
afterEach(() => vi.unstubAllGlobals());

function gateway() {
  const bodies: unknown[] = [];
  setupFetchMock({
    'GET /api/v1/repositories': () => ({ data: [], meta: { total: 0 } }),
    'GET /api/v1/workflow-templates/template-1': () => ({
      data: {
        ...template,
        activeVersionSpec: {
          spec: {
            entry: 'done',
            name: 'Summary',
            nodes: {
              done: {
                result: { text: { literal: 'summary' } },
                status: 'SUCCESS',
                type: 'terminate',
              },
            },
            schemaVersion: 1,
          },
        },
      },
    }),
    'POST /api/v1/workflow-templates/template-1/runs': (body) => {
      bodies.push(body);
      return { data: { temporalWorkflowId: 'wf-1', workRequestId: 'request-1' } };
    },
  });
  return bodies;
}

describe('workflow launch', () => {
  it('validates inputs, preserves them on Back, and launches once after review', async () => {
    const bodies = gateway();
    const launched = vi.fn();
    render(withQuery(<WorkflowLaunchForm onLaunched={launched} template={template} />));
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    expect(screen.getByText('Name this task before continuing')).toBeTruthy();
    expect(bodies).toEqual([]);
    fireEvent.change(screen.getByLabelText(/Task name/), {
      target: { value: 'Summarize the release' },
    });
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: 'Use the release notes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    expect(await screen.findByText('Declared outputs')).toBeTruthy();
    expect(bodies).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Back to details' }));
    expect((screen.getByLabelText(/Description/) as HTMLInputElement).value).toBe(
      'Use the release notes'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    const button = screen.getByRole('button', { name: 'Launch workflow' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(launched).toHaveBeenCalledWith('request-1'));
    expect(bodies).toEqual([
      { label: 'Summarize the release', payload: { description: 'Use the release notes' } },
    ]);
  });
});

describe('workflow launch after a not-actionable stop', () => {
  it('explains the refusal and launches only after Run anyway, with the flag', async () => {
    const bodies: unknown[] = [];
    setupFetchMock({
      'GET /api/v1/repositories': () => ({ data: [], meta: { total: 0 } }),
      'GET /api/v1/workflow-templates/template-1': () => ({
        data: { ...template, activeVersionSpec: { spec: null } },
      }),
    });
    const inner = vi.mocked(globalThis.fetch);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (
        init?.method === 'POST' &&
        String(input).endsWith('/workflow-templates/template-1/runs')
      ) {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        return body.acknowledgeUnchanged
          ? new Response(
              JSON.stringify({ data: { temporalWorkflowId: 'wf-1', workRequestId: 'request-2' } }),
              { headers: { 'content-type': 'application/json' }, status: 201 }
            )
          : new Response(
              JSON.stringify({
                error: {
                  code: 'UNCHANGED_AFTER_NOT_ACTIONABLE',
                  details: { previousRunId: 'run-1', stoppedAt: '2026-10-27T10:00:00.000Z' },
                  message: 'unchanged',
                },
              }),
              { headers: { 'content-type': 'application/json' }, status: 409 }
            );
      }
      return inner(input, init);
    });
    const launched = vi.fn();
    render(withQuery(<WorkflowLaunchForm onLaunched={launched} template={template} />));
    fireEvent.change(screen.getByLabelText(/Task name/), { target: { value: 'Ticket' } });
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: 'https://jira.example.com/browse/X-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Launch workflow' }));
    expect(await screen.findByText(/This request stopped before and has not changed/)).toBeTruthy();
    expect(screen.getByText(/If you have fixed what stopped it/)).toBeTruthy();
    expect(screen.getByText(/add the ticket text or acceptance criteria/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View the earlier run' }).getAttribute('href')).toBe(
      '/runs/run-1'
    );
    expect(launched).not.toHaveBeenCalled();
    const runAnyway = screen.getByRole('button', { name: 'Run anyway' }) as HTMLButtonElement;
    fireEvent.click(runAnyway);
    fireEvent.click(runAnyway);
    await waitFor(() => expect(launched).toHaveBeenCalledWith('request-2'));
    expect(launched).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty('acknowledgeUnchanged');
    expect(bodies[1]).toMatchObject({ acknowledgeUnchanged: true });
  });
});

describe('workflow launch sample', () => {
  it('fills the task name and the free-text field without launching', async () => {
    const bodies = gateway();
    render(withQuery(<WorkflowLaunchForm onLaunched={vi.fn()} template={template} />));
    fireEvent.click(screen.getByRole('button', { name: 'Try a sample task' }));
    expect((screen.getByLabelText(/Task name/) as HTMLInputElement).value).toBe('Sample task');
    expect((screen.getByLabelText(/Description/) as HTMLInputElement).value).toMatch(
      /Troubleshooting/
    );
    expect(bodies).toEqual([]);
    expect(
      (screen.getByRole('button', { name: 'Try a sample task' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('offers no sample when the workflow has no free-text field to fill', () => {
    gateway();
    render(
      withQuery(
        <WorkflowLaunchForm
          onLaunched={vi.fn()}
          template={{
            ...template,
            inputSchema: {
              properties: { count: { type: 'number' } },
              required: [],
              type: 'object',
            },
          }}
        />
      )
    );
    expect(screen.queryByRole('button', { name: 'Try a sample task' })).toBeNull();
  });
});

describe('workflow launch with a provider that needs a connection', () => {
  it('asks for a matching connection and sends it as connectionId', async () => {
    const bodies: unknown[] = [];
    setupFetchMock({
      'GET /api/v1/repositories': () => ({
        data: [
          { id: 'conn-1', name: 'Support desk', type: 'issue_tracker' },
          { id: 'conn-2', organizationName: 'acme', repoName: 'api', type: 'git_repo' },
        ],
        meta: { total: 2 },
      }),
      'GET /api/v1/workflow-templates/template-1': () => ({
        data: { ...template, activeVersionSpec: null },
      }),
      'POST /api/v1/workflow-templates/template-1/runs': (body) => {
        bodies.push(body);
        return { data: { temporalWorkflowId: 'wf-1', workRequestId: 'request-1' } };
      },
    });
    const launched = vi.fn();
    render(
      withQuery(
        <WorkflowLaunchForm
          onLaunched={launched}
          template={{ ...template, workspaceProvider: 'issue_tracker' }}
        />
      )
    );
    fireEvent.change(screen.getByLabelText(/Task name/), { target: { value: 'Triage' } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Look' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    expect(await screen.findByText('Choose a connection to run against')).toBeTruthy();
    expect(bodies).toEqual([]);

    const input = await screen.findByRole('combobox', { name: /Target connection/ });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'Support' } });
    expect(screen.queryByRole('option', { name: 'acme/api' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Support desk' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    expect((await screen.findAllByText('Support desk')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Launch workflow' }));
    await waitFor(() => expect(launched).toHaveBeenCalledWith('request-1'));
    expect(bodies).toEqual([
      { label: 'Triage', payload: { connectionId: 'conn-1', description: 'Look' } },
    ]);
  });
});
