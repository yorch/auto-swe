// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRow, BulkModelPlan } from '@/hooks/useAgentLibrary';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { BulkModelModal } from './BulkModelModal';

vi.mock('@/components/modelConfig/ModelSpecPicker', () => ({
  ModelSpecPicker: ({
    label,
    onChange,
    placeholder,
    value,
  }: {
    label?: string;
    onChange: (v: string) => void;
    placeholder?: string;
    value: string;
  }) => (
    <label>
      {label ?? placeholder}
      <input
        aria-label={label ?? placeholder}
        onChange={(e) => onChange(e.target.value)}
        value={value}
      />
    </label>
  ),
}));

const agent = (id: string, modelSpec: string | null): AgentRow => ({
  channelId: null,
  createdAt: '',
  credentialId: null,
  description: null,
  id,
  inheritsModelFrom: null,
  isActive: true,
  isBuiltIn: false,
  isVerified: true,
  key: id,
  mcpConnectionId: null,
  modelSpec,
  name: id,
  orgId: null,
  origin: null,
  runtime: 'mastra',
  scope: 'GLOBAL',
  skillRefs: [],
  systemPrompt: null,
  teamId: null,
  toolKeys: null,
  version: 1,
  workflowTemplateId: null,
});
const plan: BulkModelPlan = {
  changes: [],
  summary: {
    blocked: 0,
    conflict: 0,
    error: 0,
    inherits: 0,
    noop: 0,
    ok: 0,
    total: 0,
    unmatched: 0,
  },
};
const change = (over: Record<string, unknown> = {}) => ({
  blockers: [],
  credentialCleared: false,
  from: 'openai/old',
  id: 'a',
  inheritedFrom: null,
  key: 'a',
  name: 'Agent A',
  newId: null,
  newVersion: null,
  runtimeChange: null,
  scope: 'GLOBAL',
  shadowedBy: [],
  status: 'OK',
  to: 'anthropic/new',
  version: 1,
  warnings: [],
  ...over,
});

beforeEach(() => stubDialogPrototype());
afterEach(() => vi.unstubAllGlobals());

describe('BulkModelModal', () => {
  it('previews SET with selected ids and renders model changes before apply', async () => {
    const bodies: unknown[] = [];
    setupFetchMock({
      'POST /api/v1/platform/agent-library/bulk-model/preview': (body) => {
        bodies.push(body);
        return {
          data: { ...plan, changes: [change()], summary: { ...plan.summary, ok: 1, total: 1 } },
        };
      },
    });
    render(
      withQuery(<BulkModelModal agents={[agent('a', 'openai/old')]} onClose={vi.fn()} open />)
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Target model' }), {
      target: { value: 'anthropic/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(await screen.findByText('openai/old → anthropic/new')).toBeTruthy();
    expect(bodies).toEqual([{ ids: ['a'], mode: 'SET', modelSpec: 'anthropic/new' }]);
    expect(screen.getByRole('button', { name: 'Apply 1 changes' })).toBeTruthy();
  });

  it('maps distinct specs and includes only filled rows and the catch-all', async () => {
    let body: unknown;
    setupFetchMock({
      'POST /api/v1/platform/agent-library/bulk-model/preview': (request) => {
        body = request;
        return { data: plan };
      },
    });
    render(
      withQuery(
        <BulkModelModal
          agents={[agent('a', 'openai/old'), agent('b', 'openai/old'), agent('c', 'google/old')]}
          onClose={vi.fn()}
          open
        />
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Map each model' }));
    expect(screen.getByRole('textbox', { name: 'Target for openai/old' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Target for google/old' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Target for openai/old' }), {
      target: { value: 'anthropic/new' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Catch-all target' }), {
      target: { value: 'google/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    await waitFor(() =>
      expect(body).toEqual({
        ids: ['a', 'b', 'c'],
        mapping: { '*': 'google/new', 'openai/old': 'anthropic/new' },
        mode: 'REMAP',
      })
    );
  });

  it('shows blockers without presenting blocked agents as applicable', async () => {
    setupFetchMock({
      'POST /api/v1/platform/agent-library/bulk-model/preview': () => ({
        data: {
          ...plan,
          changes: [
            change({ blockers: ['Claude Code cannot use this provider'], status: 'BLOCKED' }),
          ],
          summary: { ...plan.summary, blocked: 1, total: 1 },
        },
      }),
    });
    render(
      withQuery(<BulkModelModal agents={[agent('a', 'openai/old')]} onClose={vi.fn()} open />)
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Target model' }), {
      target: { value: 'google/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(await screen.findByText('Claude Code cannot use this provider')).toBeTruthy();
    expect(screen.getByText('BLOCKED')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply 0 changes' }).hasAttribute('disabled')).toBe(
      true
    );
  });

  it('sends opt-ins only when checked, and only applies after a preview', async () => {
    const bodies: unknown[] = [];
    setupFetchMock({
      'POST /api/v1/platform/agent-library/bulk-model': (body) => {
        bodies.push(body);
        return {
          data: {
            ...plan,
            changes: [change({ newVersion: 2 })],
            summary: { ...plan.summary, ok: 1, total: 1 },
          },
        };
      },
      'POST /api/v1/platform/agent-library/bulk-model/preview': (body) => {
        bodies.push(body);
        return {
          data: { ...plan, changes: [change()], summary: { ...plan.summary, ok: 1, total: 1 } },
        };
      },
    });
    render(
      withQuery(<BulkModelModal agents={[agent('a', 'openai/old')]} onClose={vi.fn()} open />)
    );
    expect(screen.queryByRole('button', { name: 'Apply 1 changes' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Target model' }), {
      target: { value: 'anthropic/new' },
    });
    fireEvent.click(screen.getByText('Move Claude Code agents to the Mastra loop'));
    fireEvent.click(screen.getByText('Clear credentials pinned to another provider'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply 1 changes' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0]).toEqual({
      adaptRuntime: true,
      clearMismatchedCredentials: true,
      ids: ['a'],
      mode: 'SET',
      modelSpec: 'anthropic/new',
    });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(await screen.findByText('Saved as v2')).toBeTruthy();
  });

  it('drops the preview when an input changes, so a stale plan cannot be applied', async () => {
    setupFetchMock({
      'POST /api/v1/platform/agent-library/bulk-model/preview': () => ({
        data: { ...plan, changes: [change()], summary: { ...plan.summary, ok: 1, total: 1 } },
      }),
    });
    render(
      withQuery(<BulkModelModal agents={[agent('a', 'openai/old')]} onClose={vi.fn()} open />)
    );
    const target = screen.getByRole('textbox', { name: 'Target model' });
    fireEvent.change(target, { target: { value: 'anthropic/new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(await screen.findByRole('button', { name: 'Apply 1 changes' })).toBeTruthy();

    fireEvent.change(target, { target: { value: 'anthropic/other' } });
    expect(screen.queryByRole('button', { name: 'Apply 1 changes' })).toBeNull();
  });

  it('drops the preview when an opt-in changes', async () => {
    setupFetchMock({
      'POST /api/v1/platform/agent-library/bulk-model/preview': () => ({
        data: { ...plan, changes: [change()], summary: { ...plan.summary, ok: 1, total: 1 } },
      }),
    });
    render(
      withQuery(<BulkModelModal agents={[agent('a', 'openai/old')]} onClose={vi.fn()} open />)
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Target model' }), {
      target: { value: 'anthropic/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(await screen.findByRole('button', { name: 'Apply 1 changes' })).toBeTruthy();

    fireEvent.click(screen.getByText('Clear credentials pinned to another provider'));
    expect(screen.queryByRole('button', { name: 'Apply 1 changes' })).toBeNull();
  });

  it('ignores a preview whose answer lands after the inputs it was built from changed', async () => {
    let release: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      )
    );
    render(
      withQuery(<BulkModelModal agents={[agent('a', 'openai/old')]} onClose={vi.fn()} open />)
    );
    const target = screen.getByRole('textbox', { name: 'Target model' });
    fireEvent.change(target, { target: { value: 'anthropic/first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    await waitFor(() => expect(release).toBeDefined());

    // The operator edits the target while that preview is still in flight.
    fireEvent.change(target, { target: { value: 'anthropic/second' } });
    release?.(
      new Response(
        JSON.stringify({
          data: {
            ...plan,
            changes: [change({ to: 'anthropic/first' })],
            summary: { ...plan.summary, ok: 1, total: 1 },
          },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 }
      )
    );
    // The button leaving its pending label is what says the answer has been handled.
    await waitFor(() => screen.getByRole('button', { name: 'Preview changes' }));

    // It describes inputs the form no longer holds, so it is neither shown nor applicable.
    expect(screen.queryByRole('button', { name: 'Apply 1 changes' })).toBeNull();
    expect(screen.queryByText('openai/old → anthropic/first')).toBeNull();

    // It was received and kept, not discarded: put the input back the way it was and the same
    // answer applies again.
    fireEvent.change(target, { target: { value: 'anthropic/first' } });
    expect(screen.getByRole('button', { name: 'Apply 1 changes' })).toBeTruthy();
  });

  it('reports an inheriting agent as following its parent, not as a change', async () => {
    setupFetchMock({
      'POST /api/v1/platform/agent-library/bulk-model/preview': () => ({
        data: {
          ...plan,
          changes: [
            change({
              from: null,
              inheritedFrom: 'reviewer',
              newVersion: null,
              status: 'INHERITS',
              to: null,
            }),
          ],
          summary: { ...plan.summary, inherits: 1, total: 1 },
        },
      }),
    });
    render(withQuery(<BulkModelModal agents={[agent('p', null)]} onClose={vi.fn()} open />));
    fireEvent.change(screen.getByRole('textbox', { name: 'Target model' }), {
      target: { value: 'anthropic/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(await screen.findByText('Follows reviewer; this agent is not written.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply 0 changes' }).hasAttribute('disabled')).toBe(
      true
    );
  });

  it('drops the preview when the selection changes under it', async () => {
    setupFetchMock({
      'POST /api/v1/platform/agent-library/bulk-model/preview': () => ({
        data: { ...plan, changes: [change()], summary: { ...plan.summary, ok: 1, total: 1 } },
      }),
    });
    const element = (agents: AgentRow[]) =>
      withQuery(<BulkModelModal agents={agents} onClose={vi.fn()} open />);
    const { rerender } = render(element([agent('a', 'openai/old')]));
    fireEvent.change(screen.getByRole('textbox', { name: 'Target model' }), {
      target: { value: 'anthropic/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(await screen.findByRole('button', { name: 'Apply 1 changes' })).toBeTruthy();

    // A refetch leaves a different set selected, and the agents are part of the request.
    rerender(element([agent('b', 'openai/old')]));
    expect(screen.queryByRole('button', { name: 'Apply 1 changes' })).toBeNull();
  });

  it('holds the dialog shut while a batch is being written', async () => {
    let release: ((response: Response) => void) | undefined;
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  ...plan,
                  changes: [change()],
                  summary: { ...plan.summary, ok: 1, total: 1 },
                },
              }),
              { headers: { 'content-type': 'application/json' }, status: 200 }
            )
          );
        }
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      })
    );
    render(
      withQuery(<BulkModelModal agents={[agent('a', 'openai/old')]} onClose={vi.fn()} open />)
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Target model' }), {
      target: { value: 'anthropic/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    await screen.findByRole('button', { name: 'Apply 1 changes' });

    // Escape, a backdrop click and the header's close button all consult `dismissible`; the button
    // is the one that can be observed from here.
    const headerClose = () => document.querySelector('dialog header button');
    expect(headerClose()?.hasAttribute('disabled')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 changes' }));
    await waitFor(() => expect(release).toBeDefined());
    expect(headerClose()?.hasAttribute('disabled')).toBe(true);
  });

  it('identifies an agent whose row could not be read without inventing its scope', async () => {
    setupFetchMock({
      'POST /api/v1/platform/agent-library/bulk-model/preview': () => ({
        data: {
          ...plan,
          changes: [
            change({
              blockers: ['Could not read this agent: read failed'],
              id: 'the-unread-id',
              key: '',
              name: '',
              scope: null,
              status: 'ERROR',
            }),
          ],
          summary: { ...plan.summary, error: 1, total: 1 },
        },
      }),
    });
    render(
      withQuery(<BulkModelModal agents={[agent('a', 'openai/old')]} onClose={vi.fn()} open />)
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Target model' }), {
      target: { value: 'anthropic/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));

    // The id is the only handle the operator has for it, and its scope is not ours to guess.
    expect(await screen.findByText('the-unread-id')).toBeTruthy();
    expect(screen.getByText('Unknown')).toBeTruthy();
  });

  it('says so when an applied change could not be audited', async () => {
    setupFetchMock({
      'POST /api/v1/platform/agent-library/bulk-model': () => ({
        auditWarnings: ['a: audit store down'],
        data: {
          ...plan,
          changes: [change({ newVersion: 2 })],
          summary: { ...plan.summary, ok: 1, total: 1 },
        },
      }),
      'POST /api/v1/platform/agent-library/bulk-model/preview': () => ({
        data: { ...plan, changes: [change()], summary: { ...plan.summary, ok: 1, total: 1 } },
      }),
    });
    render(
      withQuery(<BulkModelModal agents={[agent('a', 'openai/old')]} onClose={vi.fn()} open />)
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Target model' }), {
      target: { value: 'anthropic/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply 1 changes' }));

    expect(await screen.findByText(/could not be recorded/)).toBeTruthy();
    expect(screen.getByText('a: audit store down')).toBeTruthy();
  });
});
