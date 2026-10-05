// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { SetupBanner, SetupReadiness } from './SetupReadiness';

let role = 'ADMIN';
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => role === 'ADMIN' }));

const items = [
  {
    detail: 'No credential for google.',
    href: '/studio/models?tab=credentials',
    id: 'credentials',
    label: 'Model provider credentials',
    ok: false,
  },
  {
    detail: 'Connect a repository.',
    href: '/connections',
    id: 'connections',
    label: 'Repository connection',
    ok: false,
  },
  { detail: 'ok', href: '/x', id: 'github', label: 'GitHub access', ok: true },
];

function gateway(ready = false) {
  setupFetchMock({
    'GET /api/v1/platform/readiness': () => ({
      data: { items: ready ? items.map((i) => ({ ...i, ok: true })) : items, providers: [], ready },
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  role = 'ADMIN';
});

describe('SetupReadiness', () => {
  it('reserves space while loading for admins, and nothing for others', () => {
    gateway();
    const { unmount } = render(withQuery(<SetupReadiness />));
    expect(screen.getByTestId('setup-readiness-loading')).toBeTruthy();
    unmount();
    role = 'ENGINEER';
    render(withQuery(<SetupReadiness />));
    expect(screen.queryByTestId('setup-readiness-loading')).toBeNull();
  });

  it('lists only what is missing, each linking to its fix', async () => {
    gateway();
    render(withQuery(<SetupReadiness />));
    expect(await screen.findByText('Model provider credentials')).toBeTruthy();
    expect(screen.queryByText('GitHub access')).toBeNull();
    const links = screen.getAllByRole('link', { name: /Fix this/ });
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/studio/models?tab=credentials',
      '/connections',
    ]);
  });

  it('renders nothing once setup is complete', async () => {
    gateway(true);
    const { container } = render(withQuery(<SetupReadiness />));
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders nothing for a non-admin', () => {
    role = 'ENGINEER';
    gateway();
    const { container } = render(withQuery(<SetupReadiness />));
    expect(container.textContent).toBe('');
  });

  it('banner shows only the items its page can fix', async () => {
    gateway();
    render(withQuery(<SetupBanner items={['connections']} />));
    expect(await screen.findByText(/Connect a repository/)).toBeTruthy();
    expect(screen.queryByText(/No credential for google/)).toBeNull();
  });
});
