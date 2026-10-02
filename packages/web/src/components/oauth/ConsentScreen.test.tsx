// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { ConsentScreen } from './ConsentScreen';

const signed = (scope: string, redirect = 'http://127.0.0.1:33333/cb') =>
  `?client_id=c1&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scope)}` +
  '&state=s&exp=1999999999&sig=abc&ba_param=client_id&ba_param=redirect_uri&ba_param=scope' +
  '&ba_param=state&ba_param=exp&ba_param=ba_param';

const assign = vi.fn();

const SESSION = {
  session: { expiresAt: '2099-01-01T00:00:00.000Z', id: 's1' },
  user: { email: 'a@b.c', id: 'u1', isActive: true, role: 'ENGINEER' },
};

function mockGateway(opts: { writeToolsEnabled?: boolean; enabled?: boolean; name?: string } = {}) {
  return setupFetchMock({
    '/api/auth/get-session': () => SESSION,
    '/api/auth/oauth2/public-client': () => ({ client_name: opts.name ?? 'Claude Code' }),
    '/api/v1/auth/session-token': () => ({ data: { accessToken: 'jwt-1' } }),
    'GET /api/v1/me/mcp-grants': () => ({
      data: [],
      mcp: { enabled: opts.enabled ?? true, writeToolsEnabled: opts.writeToolsEnabled ?? false },
    }),
    'POST /api/auth/oauth2/consent': () => ({
      redirect: true,
      url: 'http://127.0.0.1:33333/cb?code=abc&state=s',
    }),
  });
}

beforeEach(() => {
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => vi.unstubAllGlobals());

const approve = () => screen.getByRole('button', { name: /^approve$/i });

describe('ConsentScreen', () => {
  it('shows the app as unverified, with its name and the redirect host', async () => {
    mockGateway();
    render(withQuery(<ConsentScreen search={signed('mcp:read offline_access')} />));

    await waitFor(() => expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0));
    expect(screen.getByText('unverified')).toBeTruthy();
    expect(screen.getByText('127.0.0.1:33333')).toBeTruthy();
    // The path and query of the redirect are not shown.
    expect(screen.queryByText(/\/cb/)).toBeNull();
  });

  it('warns when the redirect stays on this computer, and not otherwise', async () => {
    mockGateway();
    const { unmount } = render(withQuery(<ConsentScreen search={signed('mcp:read')} />));
    expect(await screen.findByText(/runs on your own computer/i)).toBeTruthy();
    unmount();

    mockGateway();
    render(
      withQuery(<ConsentScreen search={signed('mcp:read', 'https://claude.ai/api/mcp/cb')} />)
    );
    await screen.findByText('claude.ai');
    expect(screen.queryByText(/runs on your own computer/i)).toBeNull();
  });

  it('offers read only, in plain language, when the app asked for read', async () => {
    mockGateway({ writeToolsEnabled: true });
    render(withQuery(<ConsentScreen search={signed('mcp:read offline_access')} />));

    expect(
      await screen.findByText(/see repositories, work requests, runs and pending approvals/i)
    ).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/stay connected for up to 14 days/i)).toBeTruthy();
  });

  it('offers write as a separate, unticked choice when the app asked for it and writes are on', async () => {
    mockGateway({ writeToolsEnabled: true });
    render(withQuery(<ConsentScreen search={signed('mcp:read mcp:write offline_access')} />));

    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/appear as you/i)).toBeTruthy();
  });

  it('hides write when the operator has not enabled it, and never sends it', async () => {
    const spy = mockGateway({ writeToolsEnabled: false });
    render(withQuery(<ConsentScreen search={signed('mcp:read mcp:write offline_access')} />));

    await waitFor(() => expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0));
    // Let the grants query settle before deciding.
    await waitFor(() =>
      expect(spy.mock.calls.some(([u]) => String(u).includes('mcp-grants'))).toBe(true)
    );
    expect(screen.queryByRole('checkbox')).toBeNull();

    fireEvent.click(approve());
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(bodyOf(spy, '/api/auth/oauth2/consent')).toMatchObject({
      accept: true,
      scope: 'mcp:read offline_access',
    });
  });

  it('sends a narrowed scope without write unless the user ticks it', async () => {
    const spy = mockGateway({ writeToolsEnabled: true });
    render(withQuery(<ConsentScreen search={signed('mcp:read mcp:write offline_access')} />));
    await screen.findByRole('checkbox');

    fireEvent.click(approve());
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('http://127.0.0.1:33333/cb?code=abc&state=s')
    );
    expect(bodyOf(spy, '/api/auth/oauth2/consent')).toMatchObject({
      accept: true,
      scope: 'mcp:read offline_access',
    });
  });

  it('sends write when the user ticks it, with the signed query', async () => {
    const spy = mockGateway({ writeToolsEnabled: true });
    render(withQuery(<ConsentScreen search={signed('mcp:read mcp:write offline_access')} />));
    fireEvent.click(await screen.findByRole('checkbox'));

    fireEvent.click(approve());
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const body = bodyOf(spy, '/api/auth/oauth2/consent') as { oauth_query: string; scope: string };
    expect(body.scope).toBe('mcp:read mcp:write offline_access');
    const query = new URLSearchParams(body.oauth_query);
    expect(query.get('sig')).toBe('abc');
    expect(query.get('client_id')).toBe('c1');
  });

  it('sends a denial, and follows the redirect the server answers with', async () => {
    const spy = mockGateway();
    render(withQuery(<ConsentScreen search={signed('mcp:read')} />));
    await screen.findByText('127.0.0.1:33333');

    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const body = bodyOf(spy, '/api/auth/oauth2/consent') as Record<string, unknown>;
    expect(body.accept).toBe(false);
    expect(body.scope).toBeUndefined();
  });

  it('cannot approve while connecting apps is switched off', async () => {
    mockGateway({ enabled: false });
    render(withQuery(<ConsentScreen search={signed('mcp:read')} />));

    expect(await screen.findByText(/turned off on this deployment/i)).toBeTruthy();
    expect((approve() as HTMLButtonElement).disabled).toBe(true);
  });

  it('says so, and decides nothing, when opened without a request', async () => {
    const spy = mockGateway();
    render(withQuery(<ConsentScreen search="" />));

    expect(await screen.findByText(/nothing to approve/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(spy.mock.calls.filter(([url]) => String(url).includes('/api/auth/oauth2/'))).toEqual([]);
  });

  it('shows the server’s reason when the decision is refused, and stays put', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/get-session')) {
          return new Response(JSON.stringify(SESSION), { status: 200 });
        }
        if (url.includes('/session-token')) {
          return new Response(JSON.stringify({ data: { accessToken: 'jwt-1' } }), { status: 200 });
        }
        if (url.includes('/consent')) {
          return new Response(
            JSON.stringify({
              error: 'invalid_scope',
              error_description: 'Write access is not enabled',
            }),
            { status: 400 }
          );
        }
        const body = url.includes('mcp-grants')
          ? { data: [], mcp: { enabled: true, writeToolsEnabled: true } }
          : { client_name: 'Claude Code' };
        void init;
        return new Response(JSON.stringify(body), { status: 200 });
      })
    );
    render(withQuery(<ConsentScreen search={signed('mcp:read')} />));
    await screen.findByText('127.0.0.1:33333');

    fireEvent.click(approve());
    expect(await screen.findByText(/write access is not enabled/i)).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it('establishes the session itself, so a browser sent here without the marker can decide', async () => {
    const spy = mockGateway();
    render(withQuery(<ConsentScreen search={signed('mcp:read')} />));

    await screen.findByText('127.0.0.1:33333');
    expect(spy.mock.calls.some(([u]) => String(u).endsWith('/api/auth/get-session'))).toBe(true);
  });

  it('asks a signed-out visitor to sign in, carrying the signed request, and decides nothing', async () => {
    const spy = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/get-session')) {
        return new Response('{}', { status: 401 });
      }
      throw new Error(`unexpected ${String(input)}`);
    });
    vi.stubGlobal('fetch', spy);
    const search = signed('mcp:read');
    render(withQuery(<ConsentScreen search={search.slice(1)} />));

    const link = (await screen.findByRole('link', { name: /sign in/i })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/login?${search.slice(1)}`);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('offers a retry, not a sign-in, when the gateway cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    render(withQuery(<ConsentScreen search={signed('mcp:read')} />));

    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
  });
});
