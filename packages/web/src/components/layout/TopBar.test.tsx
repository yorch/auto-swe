// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayStatus } from '@/hooks/useGatewayStatus';
import { TopBar } from './TopBar';

const status = vi.hoisted(() => ({ value: 'pending' as GatewayStatus }));

vi.mock('@/hooks/useGatewayStatus', () => ({ useGatewayStatus: () => status.value }));
vi.mock('@/hooks/useTeams', () => ({ useTeams: () => ({ data: [] }) }));
vi.mock('@/hooks/useApprovals', () => ({ useApprovalsCount: () => 0 }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(cleanup);

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
    expect(screen.getByText('offline').className).toContain('text-brick-400');
    expect(container.querySelector('.pulse-dot')).toBeNull();
  });

  it('shows a neutral, steady unknown state when the probe itself broke', () => {
    const { container } = renderBar('unknown');
    expect(screen.getByText('status unknown')).toBeTruthy();
    expect(screen.queryByText('offline')).toBeNull();
    expect(container.querySelector('.pulse-dot')).toBeNull();
  });
});
