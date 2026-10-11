// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    params: new URLSearchParams(),
    pending: null as { reject: (e: Error) => void; resolve: () => void } | null,
  },
}));

vi.mock('@/hooks/useUrlFilters', () => ({
  useUrlFilters: () => ({ params: state.params, update: vi.fn() }),
}));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => true }));
vi.mock('@/hooks/useTeams', () => ({ useTeams: () => ({ data: [] }) }));
vi.mock('@/hooks/useSlackChannels', () => ({ useSlackChannels: () => ({ data: [] }) }));
vi.mock('@/hooks/useAdmin', () => ({ useOrganizationDirectory: () => ({ data: [] }) }));
vi.mock('@/hooks/useConfigSettings', () => ({
  useClearConfigSetting: () => ({ mutateAsync: vi.fn() }),
  useConfigSettings: () => ({
    data: [{ group: 'workflow', key: 'workflow.x', label: 'X', source: 'GLOBAL' }],
    isError: false,
    isLoading: false,
  }),
  useSetConfigSetting: () => ({
    mutateAsync: () =>
      new Promise<void>((resolve, reject) => {
        state.pending = { reject, resolve };
      }),
  }),
}));
vi.mock('@/components/settings/SettingRow', () => ({
  SettingRow: ({
    onSave,
    status,
  }: {
    onSave: (v: unknown) => void;
    status?: { phase: string };
  }) => (
    <div>
      <button onClick={() => onSave(1)} type="button">
        save
      </button>
      <span>status:{status?.phase ?? 'none'}</span>
    </div>
  ),
}));

const { default: Page } = await import('./page');

beforeEach(() => {
  state.params = new URLSearchParams();
  state.pending = null;
});

describe('platform settings page', () => {
  it('explains how settings resolve and links to the doc', () => {
    render(<Page />);
    expect(screen.getByText('How settings resolve')).toBeTruthy();
    expect(screen.getByText(/about 30 seconds/)).toBeTruthy();
    expect(screen.getByText(/does not reach runs already in flight/)).toBeTruthy();
    expect(
      screen.getByText('How settings resolve').closest('summary')?.querySelector('button')
    ).toBeNull();
    expect(
      screen.getAllByRole('link', { name: /About the settings cascade/ })[0]?.getAttribute('href')
    ).toBe('/docs/configuration#2-resolution-order');
  });

  it('warns that a platform-wide save reaches every scope without an override', () => {
    render(<Page />);
    const callout = screen
      .getByText('Platform-wide saves reach every scope below')
      .closest('[role="status"]');
    expect(callout).not.toBeNull();
    expect(callout?.textContent).toMatch(/live value for every team, channel and template/);
    expect(callout?.textContent).toMatch(/team or channel changes only that scope/);
    expect(callout?.textContent).toMatch(
      /organization reaches every team in it that has no override/
    );
    expect(screen.getByRole('link', { name: /Who may change these/ }).getAttribute('href')).toBe(
      '/docs/configuration#3-who-may-change-what'
    );
  });

  it('records a save that settles in the view it started in', async () => {
    render(<Page />);
    fireEvent.click(screen.getByText('save'));
    expect(screen.getByText('status:saving')).toBeTruthy();
    await act(async () => state.pending?.resolve());
    expect(screen.getByText('status:saved')).toBeTruthy();
  });

  it('ignores a save that settles after the scope changed', async () => {
    const { rerender } = render(<Page />);
    fireEvent.click(screen.getByText('save'));
    state.params = new URLSearchParams('scope=TEAM&teamId=t1');
    rerender(<Page />);
    await act(async () => state.pending?.reject(new Error('late failure')));
    expect(screen.queryByText('status:error')).toBeNull();
    expect(screen.queryByText(/late failure/)).toBeNull();
  });
});
