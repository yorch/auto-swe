// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import ReviewPresetsPage from './page';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(stubDialogPrototype);
function fixture(empty = false) {
  let rows = empty
    ? []
    : [
        {
          attachments: [] as {
            id: string;
            templateId: string | null;
            connectionId: string | null;
          }[],
          description: 'Review policy',
          enabled: true,
          id: 'preset-1',
          name: 'Strict review',
          onBlocking: 'report',
          systemPrompt: null,
          template: { id: 'template-1', name: 'Code review' },
          templateId: 'template-1',
        },
      ];
  return setupFetchMock({
    '/api/v1/repositories': () => ({
      data: [{ id: 'repo-1', organizationName: 'acme', repoName: 'api', type: 'git_repo' }],
      meta: { total: 1 },
    }),
    '/api/v1/review-presets': () => ({
      data: [],
      templates: [{ id: 'template-1', name: 'Code review' }],
    }),
    '/api/v1/workflow-templates': () => ({ data: [{ id: 'workflow-1', name: 'SWE workflow' }] }),
    'DELETE /api/v1/platform/review-presets/preset-1': () => {
      rows = [];
      return { data: { deleted: true } };
    },
    'DELETE /api/v1/platform/review-presets/preset-1/attachments': () => {
      if (rows[0]) {
        rows[0].attachments = [];
      }
      return { data: {} };
    },
    'GET /api/v1/platform/review-presets': () => ({ data: rows }),
    'PATCH /api/v1/platform/review-presets/preset-1': (body) => {
      rows = rows.map((p) => ({ ...p, ...(body as object) }));
      return { data: rows[0] };
    },
    'POST /api/v1/platform/review-presets': (body) => {
      rows = [
        {
          ...rows[0],
          ...(body as object),
          attachments: [],
          id: 'new',
          template: { id: 'template-1', name: 'Code review' },
        },
      ] as typeof rows;
      return { data: rows[0] };
    },
    'POST /api/v1/platform/review-presets/preset-1/attachments': (body) => {
      const target = body as { templateId?: string; connectionId?: string };
      rows[0]?.attachments.push({
        connectionId: target.connectionId ?? null,
        id: 'attach-1',
        templateId: target.templateId ?? null,
      });
      return { data: {} };
    },
  });
}
describe('review preset administration', () => {
  it('creates a preset from the empty state and displays the fix configuration note', async () => {
    const fetch = fixture(true);
    render(withQuery(<ReviewPresetsPage />));
    await screen.findByText(/No review presets/);
    fireEvent.click(screen.getByRole('button', { name: 'New preset' }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findAllByText('Code review');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'New policy' },
    });
    expect(within(dialog).getByText('review_findings')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save preset' }));
    await screen.findByText('New policy');
    const call = fetch.mock.calls.find((c) => c[1]?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      enabled: true,
      name: 'New policy',
      onBlocking: 'report',
      systemPrompt: null,
      templateId: 'template-1',
    });
  });
  it('edits and deletes existing presets with confirmation', async () => {
    const fetch = fixture();
    render(withQuery(<ReviewPresetsPage />));
    await screen.findByText('Strict review');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Updated policy' },
    });
    fireEvent.change(screen.getByLabelText('Reviewer system prompt'), {
      target: { value: 'Inspect error paths' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
    fireEvent.click(screen.getByRole('button', { name: /On blocking findings/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Request a fix round' }));
    const save = screen.getByRole('button', { name: 'Save preset' }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await screen.findByText('Updated policy');
    expect(
      JSON.parse(String(fetch.mock.calls.find((c) => c[1]?.method === 'PATCH')?.[1]?.body))
    ).toMatchObject({
      enabled: false,
      name: 'Updated policy',
      onBlocking: 'fix',
      systemPrompt: 'Inspect error paths',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(fetch.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete preset' }));
    await screen.findByText(/No review presets/);
  });
  it.each([
    {
      kind: 'template',
      option: 'SWE workflow',
      search: 'SWE',
      target: { templateId: 'workflow-1' },
    },
    { kind: 'repository', option: 'acme/api', search: 'acme', target: { connectionId: 'repo-1' } },
  ])('adds and removes an automatic $kind attachment', async ({ kind, search, option, target }) => {
    const fetch = fixture();
    render(withQuery(<ReviewPresetsPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Attachments (0)' }));
    if (kind === 'repository') {
      fireEvent.click(screen.getByRole('button', { name: /Attachment type/ }));
      fireEvent.click(screen.getByRole('option', { name: 'Repository' }));
    }
    const input = await screen.findByRole('combobox', { name: 'Source' });
    await waitFor(() => expect(screen.queryByText(/Loading attachment sources/)).toBeNull());
    act(() => input.focus());
    fireEvent.change(input, { target: { value: search } });
    fireEvent.click(await screen.findByRole('option', { name: option }));
    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(fetch.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(true));
    expect(
      JSON.parse(String(fetch.mock.calls.find((c) => c[1]?.method === 'DELETE')?.[1]?.body))
    ).toEqual(target);
  });
  it('shows list errors instead of an empty successful list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'INTERNAL', message: 'Database unavailable' } }),
            { headers: { 'content-type': 'application/json' }, status: 500 }
          )
      )
    );
    render(withQuery(<ReviewPresetsPage />));
    expect(await screen.findByText(/Could not load review presets/)).toBeTruthy();
    expect(screen.queryByText(/No review presets/)).toBeNull();
  });
});
