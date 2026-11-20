// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TeamReviewPresetsPage from './page';

// The teams the server says the caller holds `team.codereview.manage` on; `known` is false until
// the effective permissions have loaded.
const state = vi.hoisted(() => ({
  known: true,
  managed: new Set(['mine']) as Set<string>,
}));
vi.mock('@/hooks/useCan', () => ({
  useCanOnTeams: () => (teamId: string) => state.managed.has(teamId),
}));
vi.mock('@/hooks/useEffectivePermissions', () => ({
  useEffectivePermissions: () => ({ data: state.known ? {} : undefined }),
}));
vi.mock('@/hooks/useTeams', () => ({
  useTeams: () => ({
    data: [
      { id: 'mine', name: 'My team', orgId: 'o1', orgName: 'Org' },
      { id: 'other', name: 'Other team', orgId: 'o1', orgName: 'Org' },
    ],
    isSuccess: true,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/components/ReviewPresetsView', () => ({
  ReviewPresetsView: ({ teamId }: { teamId: string }) => <p>Presets for {teamId}</p>,
}));
afterEach(() => {
  cleanup();
  state.known = true;
  state.managed = new Set(['mine']);
});
describe('team review preset view', () => {
  it('shows only the teams the caller may manage and binds the view to the selected team', () => {
    render(<TeamReviewPresetsPage />);
    expect(screen.getByText('Presets for mine')).toBeTruthy();
    expect(screen.queryByText('Other team')).toBeNull();
  });
  it('does not mount a global or other-team management view when no team is managed', () => {
    state.managed = new Set();
    render(<TeamReviewPresetsPage />);
    expect(screen.getByText('No teams you lead are available.')).toBeTruthy();
    expect(screen.queryByText('Presets for mine')).toBeNull();
  });
  it('says nothing about teams while the permissions are still loading', () => {
    state.known = false;
    state.managed = new Set();
    render(<TeamReviewPresetsPage />);
    expect(screen.queryByText('No teams you lead are available.')).toBeNull();
    expect(screen.queryByText('Presets for mine')).toBeNull();
  });
  it('lists every team the server says the caller manages, whether or not they are a member', () => {
    state.managed = new Set(['mine', 'other']);
    render(<TeamReviewPresetsPage />);
    expect(screen.getByText('Presets for mine')).toBeTruthy();
  });
});
