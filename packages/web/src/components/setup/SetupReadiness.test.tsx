// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { SetupBanner, SetupReadiness } from './SetupReadiness';

let role = 'ADMIN';
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => role === 'ADMIN' }));

const items = [
  {
    detail: 'No credential for google.',
    href: '/models?tab=credentials',
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
      data: {
        gaps: [
          { blocking: true, problem: 'no-credential', provider: 'google', subject: 'reviewer' },
        ],
        items: ready ? items.map((i) => ({ ...i, ok: true })) : items,
        providers: [],
        ready,
      },
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  role = 'ADMIN';
});

describe('SetupReadiness', () => {
  it('summarizes provider gaps on Home and puts the full agent detail behind a disclosure', async () => {
    gateway();
    render(withQuery(<SetupReadiness />));
    expect(await screen.findByText('1 agent needs a Google credential')).toBeTruthy();
    const disclosure = screen.getByText('View affected agents').closest('details');
    expect(disclosure?.hasAttribute('open')).toBe(false);
    expect(disclosure?.textContent).toContain('No credential for google.');
    fireEvent.click(screen.getByText('View affected agents'));
    expect(disclosure?.hasAttribute('open')).toBe(true);
  });
  it('collapses the compact banner without losing setup details or fix links', async () => {
    gateway();
    render(withQuery(<SetupBanner compact items={['credentials', 'connections']} />));
    const summary = await screen.findByText('Setup incomplete — 2 items need attention');
    expect(summary.parentElement?.getAttribute('open')).toBeNull();
    fireEvent.click(summary);
    expect(summary.parentElement?.getAttribute('open')).toBe('');
    expect(screen.getByText(/1 agent needs a Google credential/)).toBeTruthy();
    expect(screen.getByText('Connect a repository.')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Fix:/ })).toHaveLength(2);
  });
  it.each([false, true])(
    'shows the informational no-report note when ready=%s without expanding other done items',
    async (ready) => {
      const detail = 'No worker has reported its egress capabilities yet.';
      setupFetchMock({
        'GET /api/v1/platform/readiness': () => ({
          data: {
            items: [
              ...items.map((item) => ({ ...item, ok: ready || item.ok })),
              {
                detail,
                href: '/admin/platform-settings#group-workspace',
                id: 'egress',
                informational: true,
                label: 'Workspace egress enforcement',
                ok: true,
              },
            ],
            providers: [],
            ready,
          },
        }),
      });
      render(withQuery(<SetupReadiness />));
      expect(await screen.findByText(detail)).toBeTruthy();
      expect(screen.queryByText('ok')).toBeNull();
      if (ready) {
        expect(screen.getByText('Setup status')).toBeTruthy();
        expect(screen.queryByText(/left before runs can succeed/)).toBeNull();
        expect(screen.queryByRole('link', { name: /Fix this/ })).toBeNull();
      }
    }
  );
  it('renders the egress item and links to its settings group', async () => {
    setupFetchMock({
      'GET /api/v1/platform/readiness': () => ({
        data: {
          items: [
            {
              detail: 'No egress proxy',
              href: '/admin/platform-settings#group-workspace',
              id: 'egress',
              label: 'Workspace egress enforcement',
              ok: false,
            },
          ],
          providers: [],
          ready: false,
        },
      }),
    });
    render(withQuery(<SetupReadiness />));
    expect(await screen.findByText('No egress proxy')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Fix this/ }).getAttribute('href')).toBe(
      '/admin/platform-settings#group-workspace'
    );
  });
  it('renders nothing while loading, so a set-up admin never sees a placeholder flash', () => {
    gateway();
    const { container } = render(withQuery(<SetupReadiness />));
    expect(container.textContent).toBe('');
  });

  it('names the step in each Fix this link for screen readers', async () => {
    gateway();
    render(withQuery(<SetupReadiness />));
    expect(
      await screen.findByRole('link', { name: 'Fix this: Model provider credentials' })
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Fix this: Repository connection' })).toBeTruthy();
  });

  it('lists every step with its progress, linking only the missing ones to their fix', async () => {
    gateway();
    render(withQuery(<SetupReadiness />));
    expect(await screen.findByText('Model provider credentials')).toBeTruthy();
    // A finished step stays on the checklist, marked done, so the progress reads true.
    expect(screen.getByText('GitHub access')).toBeTruthy();
    expect(screen.getByText('1 of 3 done')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    const links = screen.getAllByRole('link', { name: /Fix this/ });
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/models?tab=credentials',
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
