// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayStatus } from '@/hooks/useGatewayStatus';
import { useEntityTitleStore } from '@/stores/entityTitleStore';
import { TopBar } from './TopBar';

const status = vi.hoisted(() => ({ value: 'pending' as GatewayStatus }));
const route = vi.hoisted(() => ({ pathname: '/' }));

vi.mock('@/hooks/useGatewayStatus', () => ({ useGatewayStatus: () => status.value }));
vi.mock('@/hooks/useTeamNav', () => ({ useTeamNav: () => ({ entries: [], isLoading: false }) }));
vi.mock('@/hooks/useUserPreferences', () => ({
  useUserPreferences: () => ({ pinnedTeamSlugs: [], setPinnedTeamSlugs: () => undefined }),
}));
vi.mock('@/hooks/useApprovals', () => ({ useApprovalsCount: () => 0 }));
vi.mock('@/hooks/useAssistant', () => ({ useAssistantStatus: () => ({ data: undefined }) }));
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(cleanup);
beforeEach(() => {
  route.pathname = '/';
  useEntityTitleStore.setState({ entry: null });
});

function renderBar(s: GatewayStatus) {
  status.value = s;
  return render(<TopBar menuButtonRef={{ current: null }} navOpen={false} onOpenNav={() => {}} />);
}

describe('TopBar gateway indicator', () => {
  it('claims nothing while the first probe is pending', () => {
    const { container } = renderBar('pending');
    expect(screen.queryByText('online')).toBeNull();
    expect(screen.getByText('checking')).toBeTruthy();
    expect(container.querySelector('.pulse-dot')).toBeNull();
  });

  it('shows a pulsing online state when reachable', () => {
    const { container } = renderBar('online');
    expect(screen.getByText('online')).toBeTruthy();
    expect(container.querySelector('.pulse-dot')).not.toBeNull();
  });

  it('shows a steady offline state when unreachable', () => {
    const { container } = renderBar('offline');
    expect(screen.getByText('offline').className).toContain('text-danger-400');
    expect(container.querySelector('.pulse-dot')).toBeNull();
  });

  it('shows a neutral, steady unknown state when the probe itself broke', () => {
    const { container } = renderBar('unknown');
    expect(screen.getByText('status unknown')).toBeTruthy();
    expect(screen.queryByText('offline')).toBeNull();
    expect(container.querySelector('.pulse-dot')).toBeNull();
  });
});

describe('TopBar context and wayfinding', () => {
  it.each(['/admin/users', '/settings', '/library/id', '/runs/id', '/docs/architecture'])(
    'omits both forms of the team switcher on %s',
    (path) => {
      route.pathname = path;
      renderBar('online');
      expect(screen.queryByRole('button', { name: 'Switch team' })).toBeNull();
    }
  );
  it('shows the pill and mobile strip on a scoped list', () => {
    route.pathname = '/requests';
    renderBar('online');
    expect(screen.getAllByRole('button', { name: 'Switch team' })).toHaveLength(2);
    expect(screen.getAllByText('All my teams')).toHaveLength(2);
  });
  it('links the parent list, shows the entity, and never uses another route’s title', () => {
    route.pathname = '/runs/id';
    useEntityTitleStore.setState({
      entry: { owner: 'test', pathname: '/runs/id', title: 'Improve API observability' },
    });
    const { rerender } = renderBar('online');
    expect(screen.getByRole('link', { name: 'All runs' }).getAttribute('href')).toBe('/runs');
    expect(screen.getByTitle('Improve API observability').getAttribute('aria-current')).toBe(
      'page'
    );
    route.pathname = '/library/id';
    rerender(<TopBar menuButtonRef={{ current: null }} navOpen={false} onOpenNav={() => {}} />);
    expect(screen.queryByText('Improve API observability')).toBeNull();
    expect(screen.getByTitle('Workflow library')).toBeTruthy();
  });
});
