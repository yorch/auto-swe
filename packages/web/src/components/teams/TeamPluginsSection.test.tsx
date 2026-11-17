// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamPlugin } from '@/hooks/useTeamPlugins';

const { disable, enable, state } = vi.hoisted(() => ({
  disable: vi.fn(),
  enable: vi.fn(),
  state: { plugins: [] as TeamPlugin[] },
}));
vi.mock('@/hooks/useTeamPlugins', () => ({
  useDisableTeamPlugin: () => ({ isPending: false, mutateAsync: disable }),
  useEnableTeamPlugin: () => ({ isPending: false, mutateAsync: enable }),
  useTeamPlugins: () => ({ data: state.plugins, error: null, isError: false, isLoading: false }),
}));

const { TeamPluginsSection } = await import('./TeamPluginsSection');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  enable.mockResolvedValue({});
  disable.mockResolvedValue({ enabled: false, name: 'review-kit', strandedAgents: [] });
  state.plugins = [
    {
      description: 'Review things',
      enabled: true,
      enabledAt: '2026-10-02T00:00:00Z',
      hooksEnabled: true,
      latestVersion: 2,
      name: 'review-kit',
    },
    {
      description: 'Docs',
      enabled: false,
      enabledAt: null,
      hooksEnabled: false,
      latestVersion: 1,
      name: 'docs-kit',
    },
  ];
});

describe('TeamPluginsSection', () => {
  it('lists plugins with hooks and enabled badges', () => {
    render(<TeamPluginsSection canManage teamId="t1" />);
    expect(screen.getByText('Hooks on')).toBeTruthy();
    expect(screen.getByText('Hooks off')).toBeTruthy();
    expect(screen.getByText('Enabled')).toBeTruthy();
  });

  it('lets a team admin enable without a prompt', async () => {
    render(<TeamPluginsSection canManage teamId="t1" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Enable docs-kit for this team' }));
    await waitFor(() => expect(enable).toHaveBeenCalledWith('docs-kit'));
  });

  it('confirms before disabling and then lists the stranded agents', async () => {
    disable.mockResolvedValue({
      enabled: false,
      name: 'review-kit',
      strandedAgents: [{ key: 'fixer', version: 3 }],
    });
    render(<TeamPluginsSection canManage teamId="t1" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Enable review-kit for this team' }));
    expect(disable).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Disable plugin' }));
    await waitFor(() => expect(disable).toHaveBeenCalledWith('review-kit'));
    expect(await screen.findByText('fixer')).toBeTruthy();
    expect(screen.getAllByText(/fail closed/).length).toBeGreaterThan(0);
  });

  it('shows members the list but disables the switches and says why', () => {
    render(<TeamPluginsSection canManage={false} teamId="t1" />);
    const toggle = screen.getByRole('switch', {
      name: 'Enable docs-kit for this team',
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toMatch(/Only a team admin/);
    expect(
      screen.getAllByText(/Only a team admin can enable or disable plugins/).length
    ).toBeGreaterThan(0);
  });
});
