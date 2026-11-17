// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { replace, state } = vi.hoisted(() => ({ replace: vi.fn(), state: { query: '' } }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/harness-profiles',
  useRouter: () => ({ push: vi.fn(), replace }),
  useSearchParams: () => new URLSearchParams(state.query),
}));
vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('./HarnessProfilesView', () => ({ HarnessProfilesView: () => <div>plugins-tab</div> }));
vi.mock('@/components/marketplaces/MarketplacesTab', () => ({
  MarketplacesTab: () => <div>marketplaces-tab</div>,
}));

const { PluginsPage } = await import('./PluginsPage');

beforeEach(() => {
  vi.clearAllMocks();
  state.query = '';
});

describe('PluginsPage', () => {
  it('is titled Plugins and opens on the plugins tab', () => {
    render(<PluginsPage />);
    expect(screen.getByRole('heading', { name: 'Plugins' })).toBeTruthy();
    expect(screen.getByText('plugins-tab')).toBeTruthy();
  });

  it('keeps the tab in the URL', () => {
    render(<PluginsPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Marketplaces' }));
    expect(replace).toHaveBeenCalledWith('/admin/harness-profiles?tab=marketplaces', {
      scroll: false,
    });
  });

  it('renders the marketplaces tab from the URL', () => {
    state.query = 'tab=marketplaces';
    render(<PluginsPage />);
    expect(screen.getByText('marketplaces-tab')).toBeTruthy();
  });
});
