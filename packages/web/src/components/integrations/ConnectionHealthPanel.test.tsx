// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { ConnectionHealthPanel } from './ConnectionHealthPanel';

const PATH = '/api/v1/platform/connections/test';
afterEach(() => vi.unstubAllGlobals());

const entry = (over: Record<string, unknown>) => ({
  detail: 'fine',
  durationMs: 3,
  group: 'integration',
  href: '/admin/integrations',
  id: 'github',
  label: 'GitHub',
  status: 'ok',
  ...over,
});

describe('ConnectionHealthPanel', () => {
  it('runs nothing until asked', () => {
    const spy = setupFetchMock({ [`POST ${PATH}`]: () => ({ data: [] }) });
    render(withQuery(<ConnectionHealthPanel />));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('lists failures before what works and what was skipped, and says how many fail', async () => {
    setupFetchMock({
      [`POST ${PATH}`]: () => ({
        data: [
          entry({ detail: 'Not configured.', id: 'figma', label: 'Figma', status: 'skipped' }),
          entry({ id: 'github', label: 'GitHub', status: 'ok' }),
          entry({
            detail: 'Slack API error: invalid_auth',
            id: 'slack',
            label: 'Slack',
            status: 'failed',
          }),
        ],
      }),
    });
    render(withQuery(<ConnectionHealthPanel />));
    fireEvent.click(screen.getByRole('button', { name: 'Test all connections' }));
    expect(await screen.findByText('1 of 2 configured connections is failing.')).toBeTruthy();
    const labels = screen.getAllByRole('link').map((a) => a.textContent);
    expect(labels).toEqual(['Slack', 'GitHub', 'Figma']);
    expect(screen.getByText('Failing')).toBeTruthy();
    expect(screen.getByText('Skipped')).toBeTruthy();
  });

  it('says everything works when nothing fails', async () => {
    setupFetchMock({
      [`POST ${PATH}`]: () => ({ data: [entry({}), entry({ id: 'slack', label: 'Slack' })] }),
    });
    render(withQuery(<ConnectionHealthPanel />));
    fireEvent.click(screen.getByRole('button', { name: 'Test all connections' }));
    expect(await screen.findByText('All 2 configured connections work.')).toBeTruthy();
  });

  it('says when there was nothing configured to test', async () => {
    setupFetchMock({
      [`POST ${PATH}`]: () => ({ data: [entry({ detail: 'Not configured.', status: 'skipped' })] }),
    });
    render(withQuery(<ConnectionHealthPanel />));
    fireEvent.click(screen.getByRole('button', { name: 'Test all connections' }));
    expect(await screen.findByText('Nothing is configured to test yet.')).toBeTruthy();
  });

  it('sends the ticket the issue tracker should fetch, and nothing when blank', async () => {
    const spy = setupFetchMock({ [`POST ${PATH}`]: () => ({ data: [] }) });
    render(withQuery(<ConnectionHealthPanel />));
    fireEvent.click(screen.getByRole('button', { name: 'Test all connections' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(bodyOf(spy, PATH)).toEqual({});

    fireEvent.change(screen.getByLabelText('A ticket for the issue tracker to fetch'), {
      target: { value: ' PAY-7 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test all connections' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const secondInit = spy.mock.calls[1]?.[1] as RequestInit | undefined;
    const second = JSON.parse(String(secondInit?.body));
    expect(second).toEqual({ trackerTicketId: 'PAY-7' });
  });

  it('shows an error when the checks cannot be run at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'nope' }), { status: 500 }))
    );
    render(withQuery(<ConnectionHealthPanel />));
    fireEvent.click(screen.getByRole('button', { name: 'Test all connections' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});
