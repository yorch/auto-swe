// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestHref } from '@/lib/requestDisplay';
import { useThemeStore } from '@/stores/themeStore';
import { withQuery } from '@/test/rtl-helpers';
import { CommandPalette } from './CommandPalette';

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/hooks/useVisibleNav', () => ({
  useVisibleNavGroups: () => [
    { items: [{ href: '/runs', icon: 'runs', label: 'Runs' }], label: 'Work' },
  ],
}));

type Handler = (url: URL) => unknown | Promise<unknown>;

/** Answer the palette's three list endpoints; every call is recorded in `calls`. */
function stubApi(handlers: { requests?: Handler; runs?: Handler; templates?: Handler }) {
  const calls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString(), 'http://gateway.test');
      calls.push(url);
      const handler = url.pathname.endsWith('/requests')
        ? handlers.requests
        : url.pathname.endsWith('/workflow-templates')
          ? handlers.templates
          : handlers.runs;
      const data = handler ? await handler(url) : [];
      return new Response(JSON.stringify({ data, meta: { limit: 5, offset: 0, total: 0 } }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    })
  );
  return calls;
}

const request = (id: string, ticket: string, description: string) => ({
  id: `run-of-${id}`,
  status: 'RUNNING',
  templateName: 'SWE',
  workRequest: { description, externalTicketId: ticket, id },
});

beforeEach(() => {
  push.mockClear();
  useThemeStore.getState().setPreference('dark');
  useThemeStore.getState().setPalette('navy');
  stubApi({});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openPalette() {
  const onOpenChange = vi.fn();
  await act(async () => {
    render(withQuery(<CommandPalette onOpenChange={onOpenChange} open />));
  });
  return onOpenChange;
}

const type = (value: string) =>
  fireEvent.change(screen.getByRole('combobox'), { target: { value } });

describe('CommandPalette', () => {
  it('runs a theme command in place instead of navigating', async () => {
    const onOpenChange = await openPalette();
    type('theme');
    fireEvent.click(screen.getByRole('option', { name: /Theme: light/ }));

    expect(useThemeStore.getState().preference).toBe('light');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('offers all three theme choices', async () => {
    await openPalette();
    type('theme');
    for (const name of [/Theme: dark/, /Theme: light/, /Theme: follow system/]) {
      expect(screen.getByRole('option', { name })).toBeTruthy();
    }
  });

  it('offers both palettes and switches in place', async () => {
    const onOpenChange = await openPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'palette' } });
    expect(screen.getByRole('option', { name: /Palette: navy/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Palette: graphite/ }));

    expect(useThemeStore.getState().palette).toBe('graphite');
    expect(document.documentElement.dataset.palette).toBe('graphite');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('still opens a page on Enter', async () => {
    await openPalette();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'runs' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/runs');
  });

  it('names the active option to assistive technology while focus stays in the input', async () => {
    await openPalette();
    const input = screen.getByRole('combobox');
    const options = screen.getAllByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(options[0]?.getAttribute('aria-selected')).toBe('false');
    expect(options).not.toContain(document.activeElement);
  });
});

describe('CommandPalette searching work', () => {
  it('shows page results immediately and makes no request before the debounce', async () => {
    const calls = stubApi({});
    await openPalette();
    type('runs');
    expect(screen.getByRole('option', { name: /Runs/ })).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('does not query the network below two characters', async () => {
    const calls = stubApi({});
    await openPalette();
    type('r');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(calls).toHaveLength(0);
  });

  it('finds a request by its ticket ID and opens it on Enter', async () => {
    const calls = stubApi({
      requests: () => [request('req-1', 'JIRA-4077', 'Harden the auth middleware')],
    });
    await openPalette();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'JIRA-4077' } });

    const row = await screen.findByRole('option', { name: /Harden the auth middleware/ });
    expect(row.textContent).toContain('JIRA-4077');
    const requestsCall = calls.find((u) => u.pathname.endsWith('/requests'));
    expect(requestsCall?.searchParams.get('search')).toBe('JIRA-4077');
    expect(requestsCall?.searchParams.get('limit')).toBe('5');
    expect(calls.find((u) => u.pathname.endsWith('/workflow-runs'))?.searchParams.get('q')).toBe(
      'JIRA-4077'
    );

    // No page matches, so the request is the active option.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith(requestHref('req-1'));
  });

  it('groups requests, runs and workflows, and arrows reach the remote options', async () => {
    stubApi({
      requests: () => [request('req-1', 'JIRA-1', 'Auth middleware')],
      runs: () => [{ ...request('req-1', 'JIRA-1', 'Auth middleware'), id: 'run-9' }],
      templates: () => [{ id: 'tpl-1', name: 'Auth rollout', status: 'ACTIVE' }],
    });
    await openPalette();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'auth' } });
    await screen.findByRole('option', { name: /Auth rollout/ });

    for (const heading of ['Requests', 'Runs', 'Workflows']) {
      expect(screen.getByText(heading)).toBeTruthy();
    }
    expect(screen.getByText('3 results')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/library/tpl-1');
  });

  it('caps each group at five', async () => {
    stubApi({
      templates: () =>
        Array.from({ length: 9 }, (_, i) => ({
          id: `t${i}`,
          name: `Deploy ${i}`,
          status: 'ACTIVE',
        })),
    });
    await openPalette();
    type('deploy');
    await screen.findByRole('option', { name: /Deploy 0/ });
    expect(screen.getAllByRole('option', { name: /^Deploy \d/ })).toHaveLength(5);
  });

  it('never shows the answer to an earlier query after the query changes', async () => {
    let releaseFirst: (rows: unknown[]) => void = () => {};
    const first = new Promise<unknown[]>((resolve) => {
      releaseFirst = resolve;
    });
    const calls = stubApi({
      requests: (url) =>
        url.searchParams.get('search') === 'alpha'
          ? first
          : [request('req-2', 'JIRA-2', 'Beta result')],
    });
    await openPalette();
    type('alpha');
    await waitFor(() =>
      expect(calls.some((u) => u.searchParams.get('search') === 'alpha')).toBe(true)
    );

    type('beta');
    await screen.findByRole('option', { name: /Beta result/ });

    // The slow answer to the older query lands last; it must not appear.
    await act(async () => {
      releaseFirst([request('req-1', 'JIRA-1', 'Alpha result')]);
    });
    expect(screen.queryByRole('option', { name: /Alpha result/ })).toBeNull();
    expect(screen.getByRole('option', { name: /Beta result/ })).toBeTruthy();
  });

  it('hides earlier results while the user is typing a new query, and says it is searching', async () => {
    stubApi({ requests: () => [request('req-1', 'JIRA-1', 'Alpha result')] });
    await openPalette();
    type('alpha');
    await screen.findByRole('option', { name: /Alpha result/ });

    type('alphab');
    expect(screen.queryByRole('option', { name: /Alpha result/ })).toBeNull();
    expect(screen.getByTestId('palette-loading')).toBeTruthy();
  });

  it('keeps page results when the network fails', async () => {
    stubApi({
      requests: () => {
        throw new Error('boom');
      },
    });
    await openPalette();
    type('runs');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(screen.getByRole('option', { name: /Runs/ })).toBeTruthy();
  });
});
