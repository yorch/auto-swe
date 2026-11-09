// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TeamReviewPresetsPage from './page';

const state = vi.hoisted(() => ({ admin: false, led: new Set(['mine']) }));
vi.mock('@/hooks/useTeams', () => ({
  useLedTeamIds: () => state.led,
  useTeams: () => ({
    data: [
      { id: 'mine', myRole: 'LEAD', name: 'My team', orgId: 'o1', orgName: 'Org' },
      { id: 'other', myRole: null, name: 'Other team', orgId: 'o1', orgName: 'Org' },
    ],
    isSuccess: true,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (select: (value: object) => unknown) =>
    select({ user: { role: state.admin ? 'ADMIN' : 'LEAD' } }),
}));
vi.mock('@/components/ReviewPresetsView', () => ({
  ReviewPresetsView: ({ teamId }: { teamId: string }) => <p>Presets for {teamId}</p>,
}));
afterEach(() => {
  cleanup();
  state.admin = false;
  state.led = new Set(['mine']);
});
describe('team review preset view', () => {
  it('shows only led teams and binds the management view to the selected team', () => {
    render(<TeamReviewPresetsPage />);
    expect(screen.getByText('Presets for mine')).toBeTruthy();
    expect(screen.queryByText('Other team')).toBeNull();
  });
  it('does not mount a global or other-team management view when no teams are led', () => {
    state.led.clear();
    render(<TeamReviewPresetsPage />);
    expect(screen.getByText('No teams you lead are available.')).toBeTruthy();
    expect(screen.queryByText('Presets for mine')).toBeNull();
  });
  it('allows platform administrators to select teams without a team membership', () => {
    state.admin = true;
    state.led.clear();
    render(<TeamReviewPresetsPage />);
    expect(screen.getByText('Presets for mine')).toBeTruthy();
  });
});
